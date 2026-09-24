import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof import('typescript');

// Execute the real route bodies with isolated dependencies, without process-global
// module mocks that would replace DB/stack exports used by other tests.
function loadRoute(method: 'POST' | 'PUT') {
	const path = method == 'POST' ? '../src/routes/api/environments/+server.ts' : '../src/routes/api/environments/[id]/+server.ts';
	const source = readFileSync(new URL(path, import.meta.url), 'utf8');
	const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
	const body = parsed.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getText(parsed)).join('\n');
	const compiled = ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
	const oldEnv = { id: 1, name: 'old', trustComposePathLabels: true };
	const writes: Record<string, unknown>[] = [];
	const effects: string[] = [];
	const persist = (data: Record<string, unknown>) => {
		writes.push(data);
		return { ...oldEnv, ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) };
	};
	const exports: Record<string, (event: unknown) => Promise<Response>> = {};
	runInNewContext(compiled, {
		exports,
		console,
		json: (data: unknown, init?: ResponseInit) => Response.json(data, init),
		authorize: async () => ({ authEnabled: false, requireEnvAccess: async () => null }),
		getEnvironment: async () => oldEnv,
		getEnvironmentByName: async () => null,
		validateEnvName: () => ({ ok: true }),
		createEnvironment: async (data: Record<string, unknown>) => persist(data),
		updateEnvironment: async (_id: number, data: Record<string, unknown>) => persist(data),
		cleanPem: (value: unknown) => value,
		serializeLabels: JSON.stringify,
		parseLabels: () => [],
		MAX_LABELS: 10,
		redactEnvironment: (value: unknown) => value,
		getEnvironmentPublicIps: async () => ({}),
		setEnvironmentPublicIp: async () => { effects.push('publicIp'); },
		refreshSubprocessEnvironments: () => { effects.push('refresh'); },
		resetHostDetection: () => { effects.push('reset'); },
		detectHostDataDir: async () => { effects.push('detect'); },
		clearDockerClientCache: () => { effects.push('cache'); },
		computeAuditDiff: () => ({}),
		auditEnvironment: async () => { effects.push('audit'); },
		getStacksDir: () => { effects.push('rename'); throw new Error('Unexpected rename'); }
	});
	return {
		writes,
		effects,
		run: (data: Record<string, unknown>) => exports[method]({
			params: { id: '1' }, cookies: {},
			request: new Request('http://localhost/api/environments', { method, body: JSON.stringify(data) })
		})
	};
}

for (const method of ['POST', 'PUT'] as const) {
	describe(`${method} trustComposePathLabels`, () => {
		for (const value of [null, 'true', 'false', '', 0, 1, [], {}]) {
			it(`rejects ${JSON.stringify(value)} before writes, renames, or cache changes`, async () => {
				const route = loadRoute(method);
				const response = await route.run({ name: 'renamed', publicIp: '192.0.2.1', trustComposePathLabels: value });
				assert.equal(response.status, 400);
				assert.deepEqual(await response.json(), { error: 'trustComposePathLabels must be a boolean' });
				assert.deepEqual(route.writes, []);
				assert.deepEqual(route.effects, []);
			});
		}

		for (const value of [false, true]) {
			it(`passes boolean ${value} through unchanged`, async () => {
				const route = loadRoute(method);
				const response = await route.run({ name: 'old', trustComposePathLabels: value });
				assert.equal(response.status, 200);
				assert.equal(route.writes.length, 1);
				assert.equal(route.writes[0].trustComposePathLabels, value);
				assert.equal((await response.json()).trustComposePathLabels, value);
			});
		}

		it('uses false on omitted create and leaves omitted update unchanged', async () => {
			const route = loadRoute(method);
			const response = await route.run({ name: 'old' });
			assert.equal(response.status, 200);
			assert.equal(route.writes[0].trustComposePathLabels, method == 'POST' ? false : undefined);
			assert.equal((await response.json()).trustComposePathLabels, method == 'PUT');
		});
	});
}
