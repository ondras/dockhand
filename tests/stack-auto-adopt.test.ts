import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { ComposePathLabelsResult } from '../src/lib/server/compose-path-labels';

const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof import('typescript');
const source = readFileSync(new URL('../src/routes/api/stacks/auto-adopt/+server.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const CONFIG_FILES = 'com.docker.compose.project.config_files';
const composePath = '/data/stacks/production/app/compose.yaml';
const eligible: ComposePathLabelsResult = { status: 'eligible', composePath };
const privatePath = '/private/SECRET/compose.yaml';

type Stack = { name: string; containerDetails?: { labels?: Record<string, string> }[] };
type Source = {
	stackName: string;
	composePath: string | null;
	sourceType: string;
	gitRepositoryId: number | null;
	gitStackId: number | null;
};
type Options = {
	environment?: { name?: string; trustComposePathLabels?: unknown; connectionType?: string | null } | null;
	authEnabled?: boolean;
	permission?: boolean;
	denied?: Response;
	stacksDirSet?: boolean;
	stacks?: Stack[];
	sources?: Source[];
	decisions?: ComposePathLabelsResult[];
	assignments?: boolean[];
	failAt?: string;
};

function stack(name: string): Stack {
	return { name, containerDetails: [{ labels: { [CONFIG_FILES]: composePath } }] };
}

function loadRoute(options: Options = {}) {
	const calls: { name: string; args: unknown[] }[] = [];
	const errors: unknown[][] = [];
	const cookies = {};
	const environment = options.environment === null ? null : {
		id: 7, name: 'production', trustComposePathLabels: true, connectionType: 'socket', ...options.environment
	};
	const record = (name: string, ...args: unknown[]) => {
		calls.push({ name, args });
		if (options.failAt == name) { throw new Error(`Unable to access ${privatePath}`); }
	};
	let decisionIndex = 0;
	let assignmentIndex = 0;
	const modules: Record<string, unknown> = {
		'@sveltejs/kit': { json: (data: unknown, init?: ResponseInit) => Response.json(data, init) },
		'node:path': { resolve },
		'$lib/server/authorize': {
			authorize: async (value: unknown) => {
				record('authorize', value);
				return {
					authEnabled: options.authEnabled ?? false,
					can: async (...args: unknown[]) => { record('can', ...args); return options.permission ?? true; },
					requireEnvAccess: async (id: number) => { record('requireEnvAccess', id); return options.denied ?? null; }
				};
			}
		},
		'$lib/server/db': {
			getEnvironment: async (id: number) => { record('getEnvironment', id); return environment; },
			getStackSources: async (id: number) => { record('getStackSources', id); return options.sources ?? []; },
			assignStackComposePathFromLabel: async (...args: unknown[]) => {
				record('assignStackComposePathFromLabel', ...args);
				return options.assignments?.[assignmentIndex++] ?? true;
			}
		},
		'$lib/server/stacks': {
			getDefaultStacksDir: () => { record('getDefaultStacksDir'); return '/data/stacks'; },
			isStacksDirEnvSet: () => { record('isStacksDirEnvSet'); return options.stacksDirSet ?? false; },
			getLocalStacksDir: () => { record('getLocalStacksDir'); return '/mnt/compose'; },
			listComposeStacks: async (id: number) => { record('listComposeStacks', id); return options.stacks ?? []; }
		},
		'$lib/server/compose-path-labels': {
			evaluateComposePathLabels: async (input: unknown) => {
				record('evaluateComposePathLabels', structuredClone(input));
				return options.decisions?.[decisionIndex++] ?? eligible;
			}
		},
		'$lib/server/audit': {
			auditStack: async (...args: unknown[]) => { record('auditStack', ...args); }
		}
	};
	const exports: { POST?: (event: unknown) => Promise<Response> } = {};
	// Imports are local to this VM. No filesystem writes, deployments, or real DB/Docker
	// modules are available, and other tests retain the real stacks.ts exports.
	runInNewContext(compiled, {
		exports,
		require: (name: string) => {
			assert.ok(Object.hasOwn(modules, name), `Unexpected route dependency: ${name}`);
			return modules[name];
		},
		console: { error: (...args: unknown[]) => { errors.push(args); } }
	});
	const event = { cookies, url: new URL('http://localhost/api/stacks/auto-adopt') };
	return {
		calls, errors, event,
		args: (name: string) => calls.filter(call => call.name == name).map(call => call.args),
		run: (env: string | null = '7') => {
			event.url.search = '';
			if (env !== null) { event.url.searchParams.set('env', env); }
			return exports.POST!(event);
		}
	};
}

describe('POST /api/stacks/auto-adopt', () => {
	for (const env of [null, '', ' ', '0', '-1', '1.5', 'NaN', 'Infinity', '7abc', '9007199254740992']) {
		it(`rejects invalid env ${JSON.stringify(env)} before authorization or side effects`, async () => {
			const route = loadRoute();
			const response = await route.run(env);
			assert.equal(response.status, 400);
			assert.deepEqual(await response.json(), { error: 'A valid environment ID is required' });
			assert.deepEqual(route.calls, []);
		});
	}

	it('requires stacks:create permission for the requested environment before looking it up', async () => {
		const route = loadRoute({ authEnabled: true, permission: false });
		const response = await route.run('42');
		assert.equal(response.status, 403);
		assert.deepEqual(await response.json(), { error: 'Permission denied' });
		assert.deepEqual(route.calls, [
			{ name: 'authorize', args: [route.event.cookies] },
			{ name: 'can', args: ['stacks', 'create', 42] }
		]);
	});

	for (const authEnabled of [true, false]) {
		it(`enforces environment isolation with authEnabled=${authEnabled}`, async () => {
			const denied = Response.json({ error: 'Environment access denied' }, { status: 403 });
			const route = loadRoute({ authEnabled, denied });
			assert.equal(await route.run('42'), denied);
			assert.deepEqual(route.args('requireEnvAccess'), [[42]]);
			assert.deepEqual(route.calls.map(call => call.name), authEnabled
				? ['authorize', 'can', 'requireEnvAccess'] : ['authorize', 'requireEnvAccess']);
		});
	}

	it('returns 404 for a missing environment without discovery or validation', async () => {
		const route = loadRoute({ environment: null });
		const response = await route.run();
		assert.equal(response.status, 404);
		assert.deepEqual(await response.json(), { error: 'Environment not found' });
		assert.deepEqual(route.calls.map(call => call.name), ['authorize', 'requireEnvAccess', 'getEnvironment']);
	});

	for (const trustComposePathLabels of [false, undefined, null, 'true', 1]) {
		it(`does no Docker, filesystem validation, or DB mutation when trust is ${String(trustComposePathLabels)}`, async () => {
			const route = loadRoute({ environment: { trustComposePathLabels, connectionType: 'tcp' }, stacks: [stack('app')] });
			const response = await route.run();
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { results: [] });
			assert.deepEqual(route.calls.map(call => call.name), ['authorize', 'requireEnvAccess', 'getEnvironment']);
			assert.deepEqual(route.errors, []);
		});
	}

	for (const connectionType of ['tcp', 'ssh', 'agent']) {
		it(`rejects ${connectionType} connections before discovery or filesystem validation`, async () => {
			const route = loadRoute({ environment: { connectionType }, stacks: [stack('app')] });
			const response = await route.run();
			assert.equal(response.status, 400);
			assert.deepEqual(await response.json(), { error: 'Automatic Compose path assignment requires a local Docker socket' });
			assert.deepEqual(route.calls.map(call => call.name), ['authorize', 'requireEnvAccess', 'getEnvironment']);
		});
	}

	for (const connectionType of ['socket', null]) {
		it(`accepts ${JSON.stringify(connectionType)} as a local socket and only assigns metadata`, async () => {
			const route = loadRoute({ authEnabled: true, environment: { connectionType }, stacks: [stack('app')] });
			const response = await route.run();
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { results: [{ stackName: 'app', status: 'assigned' }] });
			assert.deepEqual(route.calls.map(call => call.name), [
				'authorize', 'can', 'requireEnvAccess', 'getEnvironment', 'getDefaultStacksDir', 'isStacksDirEnvSet',
				'listComposeStacks', 'getStackSources', 'evaluateComposePathLabels', 'assignStackComposePathFromLabel', 'auditStack'
			]);
			assert.deepEqual(route.args('assignStackComposePathFromLabel'), [['app', 7, composePath]]);
			const [audit] = route.args('auditStack');
			assert.equal(audit[0], route.event);
			assert.deepEqual(structuredClone(audit.slice(1)), ['create', 'app', 7, { source: 'compose-path-label', composePath }]);
			assert.deepEqual(route.errors, []);
		});
	}

	for (const stacksDirSet of [false, true]) {
		it(`scopes roots to env.name and includes STACKS_DIR only when explicitly set (${stacksDirSet})`, async () => {
			const route = loadRoute({ environment: { name: 'east-cluster' }, stacksDirSet, stacks: [stack('app'), stack('worker')] });
			const response = await route.run('42');
			assert.equal(response.status, 200);
			const roots = stacksDirSet ? ['/data/stacks/east-cluster', '/mnt/compose'] : ['/data/stacks/east-cluster'];
			assert.deepEqual(route.args('evaluateComposePathLabels'), [
				[{ containerLabels: [{ [CONFIG_FILES]: composePath }], roots }],
				[{ containerLabels: [{ [CONFIG_FILES]: composePath }], roots }]
			]);
			assert.equal(route.args('getLocalStacksDir').length, stacksDirSet ? 1 : 0);
			for (const name of ['requireEnvAccess', 'getEnvironment', 'listComposeStacks', 'getStackSources']) {
				assert.deepEqual(route.args(name), [[42]]);
			}
			assert.deepEqual(route.args('assignStackComposePathFromLabel'), [['app', 42, composePath], ['worker', 42, composePath]]);
		});
	}

	it('lists Docker stacks exactly once per reconciliation, including an empty result', async () => {
		for (const stacks of [[], [stack('app'), stack('worker'), stack('db')]]) {
			const route = loadRoute({ stacks });
			for (let count = 1; count <= 2; count++) {
				const response = await route.run();
				assert.equal(response.status, 200);
				assert.equal((await response.json()).results.length, stacks.length);
				assert.equal(route.args('listComposeStacks').length, count);
				assert.equal(route.args('getStackSources').length, count);
			}
		}
	});

	it('preserves internal, Git, and manual assignments without inspecting even inaccessible paths', async () => {
		const external: Source = { stackName: 'metadata-only', sourceType: 'external', composePath: null, gitRepositoryId: null, gitStackId: null };
		const sources: Source[] = [
			{ ...external, stackName: 'internal', sourceType: 'internal' },
			{ ...external, stackName: 'git', sourceType: 'git' },
			{ ...external, stackName: 'git-repository', gitRepositoryId: 10 },
			{ ...external, stackName: 'git-stack', gitStackId: 20 },
			{ ...external, stackName: 'manual', composePath: '/mnt/manual/compose.yaml' },
			{ ...external, stackName: 'inaccessible', composePath: privatePath },
			{ ...external, stackName: 'empty-assignment', composePath: '' },
			external
		];
		const route = loadRoute({ sources, stacks: [...sources.map(source => stack(source.stackName)), stack('unassigned')] });
		const response = await route.run();
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { results: [
			...sources.slice(0, -1).map(source => ({ stackName: source.stackName, status: 'preserved' })),
			{ stackName: 'metadata-only', status: 'assigned' },
			{ stackName: 'unassigned', status: 'assigned' }
		] });
		assert.equal(route.args('evaluateComposePathLabels').length, 2);
		assert.deepEqual(route.args('assignStackComposePathFromLabel'), [['metadata-only', 7, composePath], ['unassigned', 7, composePath]]);
		assert.deepEqual(route.args('auditStack').map(args => args[2]), ['metadata-only', 'unassigned']);
	});

	it('passes all container labels, including missing labels, to the validator and returns its rejection details', async () => {
		const decisions: ComposePathLabelsResult[] = [
			{ status: 'rejected', reason: 'adoption_disabled', message: 'A container has disabled stack adoption.' },
			{ status: 'rejected', reason: 'missing_config_files', message: 'Every container must advertise a nonempty Compose config-files label.' },
			{ status: 'rejected', reason: 'outside_roots', message: 'The Compose file is outside the allowed roots.' }
		];
		const containerLabels: Record<string, string>[] = [{ [CONFIG_FILES]: composePath }, { 'dockhand.adopt': 'false' }, {}];
		const route = loadRoute({ decisions, stacks: [
			{ name: 'opted-out', containerDetails: [{ labels: containerLabels[0] }, { labels: containerLabels[1] }, {}] },
			{ name: 'no-details' },
			stack('outside')
		] });
		const response = await route.run();
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { results: ['opted-out', 'no-details', 'outside'].map((stackName, index) => ({ stackName, ...decisions[index] })) });
		assert.deepEqual(route.args('evaluateComposePathLabels'), [
			[{ containerLabels, roots: ['/data/stacks/production'] }],
			[{ containerLabels: [], roots: ['/data/stacks/production'] }],
			[{ containerLabels: [{ [CONFIG_FILES]: composePath }], roots: ['/data/stacks/production'] }]
		]);
		assert.deepEqual(route.args('assignStackComposePathFromLabel'), []);
		assert.deepEqual(route.args('auditStack'), []);
	});

	it('reports a concurrent assignment as preserved and audits only successful assignments', async () => {
		const route = loadRoute({ stacks: [stack('raced'), stack('assigned')], assignments: [false, true] });
		const response = await route.run();
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { results: [
			{ stackName: 'raced', status: 'preserved' }, { stackName: 'assigned', status: 'assigned' }
		] });
		assert.deepEqual(route.args('assignStackComposePathFromLabel'), [['raced', 7, composePath], ['assigned', 7, composePath]]);
		assert.deepEqual(route.args('auditStack').map(args => args[2]), ['assigned']);
	});

	for (const failAt of ['getEnvironment', 'getDefaultStacksDir', 'listComposeStacks', 'getStackSources', 'evaluateComposePathLabels', 'assignStackComposePathFromLabel', 'auditStack']) {
		it(`returns a generic failure without leaking paths when ${failAt} throws`, async () => {
			const route = loadRoute({ failAt, stacks: [stack('app')] });
			const response = await route.run();
			assert.equal(response.status, 500);
			const body = await response.text();
			assert.deepEqual(JSON.parse(body), { error: 'Failed to discover or assign Compose files' });
			assert.ok(!body.includes(privatePath));
			assert.ok(!body.includes('SECRET'));
			assert.equal(route.errors.length, 1);
			assert.equal(route.calls.at(-1)?.name, failAt);
			if (failAt != 'auditStack') { assert.deepEqual(route.args('auditStack'), []); }
		});
	}
});
