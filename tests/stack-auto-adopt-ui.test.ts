import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { compile } from 'svelte/compiler';
import ts from 'typescript';

const filename = new URL('../src/routes/stacks/+page.svelte', import.meta.url);
const source = readFileSync(filename, 'utf8');
const script = source.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1];
const ast = ts.createSourceFile('page.ts', script, ts.ScriptTarget.Latest, true);
// Execute the actual request functions, with stores/network mocked, without mounting the whole page.
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) &&
	['fetchStacks', 'fetchStacksForEnvironment'].includes(node.name!.text));
const declarations = ast.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []);
const requestState = declarations.filter(node => ['stacksRequest', 'stacksRequestId'].includes(node.name.getText(ast)));
const eligibility = declarations.find(node => node.name.getText(ast) === 'autoAdoptEnabled')!.initializer as ts.CallExpression;
const executable = ts.transpileModule([
	...requestState.map(node => `let ${node.getText(ast)};`),
	...functions.map(node => node.getText(ast)),
	`Object.defineProperty(globalThis, 'autoAdoptEnabled', { get: () => (${eligibility.arguments[0].getText(ast)}) });`
].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(r => { resolve = r; });
	return { promise, resolve };
}

function setup() {
	const fetch = mock(async (url: string, _options?: RequestInit) => Response.json(
		url.includes('/auto-adopt') ? { results: [] } : url.startsWith('/api/stacks?') ? [{ name: 'loaded' }] :
		url.includes('/git/stacks') ? [] : {}
	));
	const context = createContext({
		envId: 1, $currentEnvironment: { id: 1 }, currentEnvDetails: { trustComposePathLabels: true, connectionType: 'socket' },
		$canAccess: mock(() => true), fetch, console, toast: { error: mock() },
		appendEnvParam: (url: string, id: number) => `${url}?env=${id}`,
		clearStaleEnvironment: mock(), environments: { refresh: mock() },
		lastLoadedEnvId: null, loading: true, stacks: [], stackSources: {}, gitStacks: [], iconOverrides: {}, stackEnvVarCounts: {},
		autoAdoptError: null, autoAdoptRejections: {}
	});
	runInContext(executable, context);
	return { context, fetch, refresh: () => context.fetchStacks() as Promise<void> };
}

describe('stack auto-adoption UI', () => {
	test('the page compiles', () => {
		expect(() => compile(source, { filename: filename.pathname, generate: 'client' })).not.toThrow();
	});

	test('event/poll bursts share a slow POST and GET without starving results', async () => {
		const { context, fetch, refresh } = setup();
		const post = deferred<Response>(), get = deferred<Response>();
		fetch.mockImplementationOnce(() => post.promise).mockImplementationOnce(() => get.promise);
		const first = refresh();
		for (let i = 0; i < 50; i++) { expect(refresh()).toBe(first); }
		expect(fetch.mock.calls).toEqual([['/api/stacks/auto-adopt?env=1', { method: 'POST' }]]);
		post.resolve(Response.json({ results: [{ stackName: 'unsafe', status: 'rejected', reason: 'unsafe_path', message: 'Not allowed' }] }));
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(fetch).toHaveBeenCalledTimes(5);
		for (let i = 0; i < 50; i++) { expect(refresh()).toBe(first); }
		get.resolve(Response.json([{ name: 'unsafe' }]));
		await first;
		expect(context.stacks).toEqual([{ name: 'unsafe' }]);
		expect(context.autoAdoptRejections).toEqual({ unsafe: 'unsafe_path: Not allowed' });
		expect(context.loading).toBe(false);
		await refresh();
		expect(fetch).toHaveBeenCalledTimes(10);
	});

	for (const setting of ['trust', 'permission']) {
		test(`${setting} arriving during a disabled request starts adoption`, async () => {
			const { context, fetch, refresh } = setup();
			if (setting === 'trust') { context.currentEnvDetails.trustComposePathLabels = false; }
			else { context.$canAccess.mockReturnValue(false); }
			const oldGet = deferred<Response>(), post = deferred<Response>();
			fetch.mockImplementationOnce(() => oldGet.promise);
			const old = refresh();
			expect(fetch).toHaveBeenCalledTimes(4);
			context.currentEnvDetails.trustComposePathLabels = true;
			context.$canAccess.mockReturnValue(true);
			fetch.mockImplementationOnce(() => post.promise);
			const current = refresh();
			expect(current).not.toBe(old);
			expect(fetch.mock.calls[4]).toEqual(['/api/stacks/auto-adopt?env=1', { method: 'POST' }]);
			oldGet.resolve(Response.json([{ name: 'stale' }]));
			await old;
			expect(context.stacks).toEqual([]);
			expect(context.loading).toBe(true);
			expect(refresh()).toBe(current); // Old cleanup must not discard the new in-flight request.
			post.resolve(Response.json({ results: [] }));
			await current;
			expect(context.stacks).toEqual([{ name: 'loaded' }]);
		});
	}

	test('switching environments invalidates the old POST, including switching back', async () => {
		const { context, fetch, refresh } = setup();
		const post = deferred<Response>();
		fetch.mockImplementationOnce(() => post.promise);
		const old = refresh();
		context.envId = context.$currentEnvironment.id = 2;
		await refresh();
		context.envId = context.$currentEnvironment.id = 1;
		await refresh();
		post.resolve(Response.json({ results: [{ stackName: 'stale', status: 'rejected' }] }));
		await old;
		expect(context.autoAdoptRejections).toEqual({});
		expect(context.stacks).toEqual([{ name: 'loaded' }]);
		expect(fetch).toHaveBeenCalledTimes(11); // Stale POST must not start its GETs.
	});

	test('POST failure still loads stacks without toasts and allows retry', async () => {
		const { context, fetch, refresh } = setup();
		fetch.mockResolvedValueOnce(Response.json({ error: 'Unavailable' }, { status: 500 }));
		await refresh();
		expect(context.autoAdoptError).toBe('Unavailable');
		expect(context.stacks).toEqual([{ name: 'loaded' }]);
		expect(context.toast.error).not.toHaveBeenCalled();
		await refresh();
		expect(context.autoAdoptError).toBeNull();
		expect(fetch).toHaveBeenCalledTimes(10);
	});

	test('socket/null are eligible; disabled, remote, and unprivileged requests only GET', async () => {
		for (const [connectionType, trust, permission, expectedCalls] of [
			['socket', true, true, 5], [null, true, true, 5], ['socket', false, true, 4],
			['direct', true, true, 4], ['hawser-standard', true, true, 4], ['hawser-edge', true, true, 4], ['socket', true, false, 4]
		] as const) {
			const { context, fetch, refresh } = setup();
			context.currentEnvDetails = { connectionType, trustComposePathLabels: trust };
			context.$canAccess.mockReturnValue(permission);
			await refresh();
			expect(fetch).toHaveBeenCalledTimes(expectedCalls);
			expect(fetch.mock.calls[0][0].includes('/auto-adopt')).toBe(expectedCalls === 5);
		}
	});
});
