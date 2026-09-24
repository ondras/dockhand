import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { Database } from 'bun:sqlite';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { drizzle as pgDrizzle } from 'drizzle-orm/pg-proxy';
import ts from 'typescript';
import { stackSources } from '../src/lib/server/db/schema';
import { stackSources as pgStackSources } from '../src/lib/server/db/schema/pg-schema';

type Operations = Pick<typeof import('../src/lib/server/db'), 'assignStackComposePathFromLabel' | 'upsertStackSource' | 'getStackSource'>;
type StackSource = typeof stackSources.$inferSelect;
type Query = { sql: string; params: unknown[] };

// Extract declarations, not copies of their implementations. Importing db.ts would
// initialize the production database/native driver and affect other test files.
const path = '../src/lib/server/db.ts';
const source = readFileSync(new URL(path, import.meta.url), 'utf8');
const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
const names = ['assignStackComposePathFromLabel', 'upsertStackSource', 'getStackSource'];
const declarations = parsed.statements.filter(statement =>
	ts.isFunctionDeclaration(statement) && statement.name && names.includes(statement.name.text)
);
assert.equal(declarations.length, names.length, 'All production functions must be extracted');
const compiled = declarations.map(statement => ({
	name: (statement as import('typescript').FunctionDeclaration).name!.text,
	code: ts.transpileModule(statement.getText(parsed), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
	}).outputText
}));

function loadOperations(db: unknown, table: unknown = stackSources, afterRead?: (row: Awaited<ReturnType<Operations['getStackSource']>>) => Promise<void>) {
	const exports = {} as Operations;
	const context: Record<string, unknown> = {
		exports, db, stackSources: table, and, eq, isNull,
		console: { log() {} },
		getGitRepository: () => { throw new Error('Unexpected repository lookup'); },
		getGitStack: () => { throw new Error('Unexpected git stack lookup'); }
	};
	// Separate VM evaluations let the race hook wrap the real SELECT rather than
	// replacing its result or mocking any Drizzle query builders.
	runInNewContext(compiled.find(fn => fn.name == 'getStackSource')!.code, context);
	context.getStackSource = async (...args: Parameters<Operations['getStackSource']>) => {
		const row = await exports.getStackSource(...args);
		await afterRead?.(row);
		return row;
	};
	for (const fn of compiled.filter(fn => fn.name != 'getStackSource')) {
		runInNewContext(fn.code, context);
	}
	return exports;
}

function assertConditionalAssignment(query: Query) {
	assert.match(query.sql, /on conflict\s*\((?:"stack_sources"\.)?"stack_name",\s*(?:"stack_sources"\.)?"environment_id"\) do update set /i);
	assert.match(query.sql, /do update set .* where /i);
	assert.match(query.sql, /"stack_sources"\."source_type" = (?:\?|\$\d+)/);
	for (const column of ['compose_path', 'git_repository_id', 'git_stack_id']) {
		assert.ok(query.sql.includes(`"stack_sources"."${column}" is null`), query.sql);
	}
	assert.match(query.sql, /returning "id"$/);
	assert.equal(query.params.at(-1), 'external');
	const update = query.sql.split('do update set ')[1].split(' where ')[0];
	for (const column of ['compose_path', 'source_type', 'updated_at']) {
		assert.ok(update.includes(`"${column}" = `), update);
	}
	for (const column of ['icon', 'env_path', 'secret_provider_id', 'injected_secret_keys', 'created_at']) {
		assert.ok(!update.includes(`"${column}"`), update);
	}
}

describe('assignStackComposePathFromLabel with SQLite', () => {
	let sqlite: Database;
	let db: ReturnType<typeof drizzle>;
	let operations: Operations;
	let queries: Query[];
	const metadata = {
		icon: 'selfhst:nginx',
		envPath: '/stacks/app/custom.env',
		secretProviderId: 42,
		injectedSecretKeys: '["TOKEN"]',
		createdAt: '2020-01-01T00:00:00.000Z',
		updatedAt: '2020-01-02T00:00:00.000Z'
	};

	beforeEach(() => {
		sqlite = new Database(':memory:');
		// Only the table under test is needed. Foreign-key target tables are omitted;
		// the real Drizzle schema still supplies column mapping and query generation.
		sqlite.exec(`CREATE TABLE stack_sources (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			stack_name TEXT NOT NULL,
			environment_id INTEGER,
			source_type TEXT NOT NULL DEFAULT 'internal',
			git_repository_id INTEGER,
			git_stack_id INTEGER,
			compose_path TEXT,
			env_path TEXT,
			secret_provider_id INTEGER,
			injected_secret_keys TEXT,
			icon TEXT,
			created_at TEXT DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
			UNIQUE (stack_name, environment_id)
		)`);
		queries = [];
		db = drizzle(sqlite, { logger: { logQuery(sql, params) { queries.push({ sql, params }); } } });
		operations = loadOperations(db);
	});

	afterEach(() => { sqlite.close(); });

	function seed(values: Partial<StackSource> = {}) {
		return db.insert(stackSources).values({
			stackName: 'app', environmentId: 1, sourceType: 'external', ...metadata, ...values
		}).returning().get();
	}

	function rows() { return db.select().from(stackSources).orderBy(stackSources.id).all(); }

	it('inserts an internal assignment in one conditional SQL statement', async () => {
		assert.equal(await operations.assignStackComposePathFromLabel('app', 1, '/labels/compose.yaml'), true);
		assert.equal(queries.length, 1, 'Assignment must not select before inserting');
		assertConditionalAssignment(queries[0]);
		assert.ok(queries[0].params.includes('/labels/compose.yaml'));
		const [row] = rows();
		assert.deepEqual(row, {
			id: 1, stackName: 'app', environmentId: 1, sourceType: 'internal',
			composePath: '/labels/compose.yaml', envPath: null, gitRepositoryId: null,
			gitStackId: null, secretProviderId: null, injectedSecretKeys: null, icon: null,
			createdAt: row.createdAt, updatedAt: row.updatedAt
		});
		assert.ok(row.createdAt);
		assert.ok(row.updatedAt);
	});

	for (const sourceType of ['external', 'internal', 'git'] as const) {
		it(`does not overwrite an assigned ${sourceType} path`, async () => {
			const before = seed({ sourceType, composePath: '/manual/compose.yaml' });
			assert.equal(await operations.assignStackComposePathFromLabel('app', 1, '/labels/compose.yaml'), false);
			assert.deepEqual(rows(), [before]);
		});
	}

	for (const sourceType of ['internal', 'git'] as const) {
		it(`preserves an unassigned ${sourceType} row even with no git references`, async () => {
			const before = seed({ sourceType, composePath: null });
			assert.equal(await operations.assignStackComposePathFromLabel('app', 1, '/labels/compose.yaml'), false);
			assert.deepEqual(rows(), [before]);
		});
	}

	for (const reference of ['gitRepositoryId', 'gitStackId'] as const) {
		it(`preserves an external null-path row with ${reference}`, async () => {
			const before = seed({ [reference]: 7 });
			assert.equal(await operations.assignStackComposePathFromLabel('app', 1, '/labels/compose.yaml'), false);
			assert.deepEqual(rows(), [before]);
		});
	}

	it('adopts an external metadata-only row without replacing its identity or metadata', async () => {
		const before = seed();
		assert.equal(await operations.assignStackComposePathFromLabel('app', 1, '/labels/compose.yaml'), true);
		const [after] = rows();
		assert.notEqual(after.updatedAt, before.updatedAt);
		assert.deepEqual(after, {
			...before, sourceType: 'internal', composePath: '/labels/compose.yaml', updatedAt: after.updatedAt
		});
	});

	it('keeps the same stack name in different environments separate, including null', async () => {
		const other = seed({ environmentId: 2 });
		const legacy = seed({ environmentId: null });
		assert.equal(await operations.assignStackComposePathFromLabel('app', 1, '/env1/compose.yaml'), true);
		assert.deepEqual(rows().slice(0, 2), [other, legacy]);
		const first = rows()[2];
		assert.equal(await operations.assignStackComposePathFromLabel('app', 2, '/env2/compose.yaml'), true);
		const result = rows();
		assert.equal(result.length, 3);
		assert.equal(result[0].composePath, '/env2/compose.yaml');
		assert.equal(result[0].environmentId, 2);
		assert.deepEqual(result[1], legacy);
		assert.deepEqual(result[2], first);
	});

	for (const existing of [false, true]) {
		it(`repeated assignments are no-ops after ${existing ? 'updating metadata' : 'inserting'}`, async () => {
			if (existing) { seed(); }
			assert.equal(await operations.assignStackComposePathFromLabel('app', 1, '/labels/compose.yaml'), true);
			// A sentinel makes an unwanted timestamp write observable without sleeps.
			db.update(stackSources).set({ updatedAt: metadata.updatedAt }).run();
			const before = rows();
			for (const composePath of ['/labels/compose.yaml', '/changed/compose.yaml']) {
				assert.equal(await operations.assignStackComposePathFromLabel('app', 1, composePath), false);
				assert.deepEqual(rows(), before);
			}
		});
	}

	it('upsertStackSource inserts a manual source normally and later label assignment loses', async () => {
		const result = await operations.upsertStackSource({
			stackName: 'app', environmentId: 1, sourceType: 'internal',
			composePath: '/manual/compose.yaml', envPath: metadata.envPath,
			icon: metadata.icon, secretProviderId: metadata.secretProviderId
		});
		const [before] = rows();
		assert.equal(result.id, before.id);
		assert.equal(result.composePath, '/manual/compose.yaml');
		assert.equal(result.envPath, metadata.envPath);
		assert.equal(result.icon, metadata.icon);
		assert.equal(result.secretProviderId, metadata.secretProviderId);
		assert.equal(await operations.assignStackComposePathFromLabel('app', 1, '/labels/compose.yaml'), false);
		assert.deepEqual(rows(), [before]);
	});

	it('retries a manual insert lost to automatic assignment, preserving omitted metadata', async () => {
		let reads = 0;
		let automatic: StackSource | undefined;
		const manual = loadOperations(db, stackSources, async row => {
			reads++;
			if (reads != 1) { return; }
			assert.equal(row, null, 'Manual save must first observe no source');
			assert.equal(await operations.assignStackComposePathFromLabel('app', 1, '/labels/compose.yaml'), true);
			db.update(stackSources).set(metadata).run();
			[automatic] = rows();
		});
		const result = await manual.upsertStackSource({
			stackName: 'app', environmentId: 1, sourceType: 'internal',
			composePath: '/manual/compose.yaml', envPath: '/manual/custom.env'
		});
		assert.ok(automatic);
		assert.equal(reads, 3, 'Initial read, conflict retry read, and final read');
		const [after] = rows();
		assert.deepEqual(rows(), [{
			...automatic, composePath: '/manual/compose.yaml', envPath: '/manual/custom.env', updatedAt: after.updatedAt
		}]);
		assert.notEqual(after.updatedAt, automatic.updatedAt);
		assert.equal(result.id, automatic.id);
		assert.equal(result.composePath, after.composePath);
		assert.equal(result.icon, metadata.icon);
		assert.equal(result.secretProviderId, metadata.secretProviderId);
		const inserts = queries.filter(query => query.sql.startsWith('insert into'));
		assert.equal(inserts.length, 2);
		assertConditionalAssignment(inserts[0]);
		assert.match(inserts[1].sql, /on conflict do nothing returning "id"$/);
		assert.equal(queries.filter(query => query.sql.startsWith('update ')).length, 2);
	});

	for (const existing of [false, true]) {
		it(`icon-only external upsert preserves assignment ${existing ? 'after selecting an external row' : 'inserted before its own insert'}`, async () => {
			if (existing) { seed(); }
			queries.length = 0;
			let reads = 0;
			let assigned: StackSource | undefined;
			const iconSave = loadOperations(db, stackSources, async row => {
				reads++;
				if (reads != 1) { return; }
				if (existing) {
					assert.ok(row);
					assert.equal(row.sourceType, 'external');
					assert.equal(row.composePath, null);
				} else {
					assert.equal(row, null);
				}
				assert.equal(await operations.assignStackComposePathFromLabel('app', 1, '/labels/compose.yaml'), true);
				[assigned] = rows();
			});
			const result = await iconSave.upsertStackSource({
				stackName: 'app', environmentId: 1, sourceType: 'external', icon: 'server'
			});
			assert.ok(assigned);
			assert.equal(reads, existing ? 2 : 3);
			const [after] = rows();
			assert.deepEqual(rows(), [{ ...assigned, icon: 'server', updatedAt: after.updatedAt }]);
			assert.equal(result.id, assigned.id);
			assert.equal(result.sourceType, 'internal');
			assert.equal(result.composePath, '/labels/compose.yaml');
			assert.equal(result.icon, 'server');
			const inserts = queries.filter(query => query.sql.startsWith('insert into'));
			assert.equal(inserts.length, existing ? 1 : 2);
			assertConditionalAssignment(inserts[0]);
			if (!existing) { assert.match(inserts[1].sql, /on conflict do nothing returning "id"$/); }
			const updates = queries.filter(query => query.sql.startsWith('update '));
			assert.equal(updates.length, 1);
			assert.match(updates[0].sql, /"icon" = \?/);
			for (const column of ['source_type', 'compose_path', 'git_repository_id', 'git_stack_id', 'env_path', 'secret_provider_id']) {
				assert.ok(!updates[0].sql.includes(`"${column}" = `), updates[0].sql);
			}
		});
	}

	it('explicit composePath null is a manual clear, not an icon-only metadata save', async () => {
		const before = seed({ sourceType: 'internal', composePath: '/labels/compose.yaml' });
		const result = await operations.upsertStackSource({
			stackName: 'app', environmentId: 1, sourceType: 'external', composePath: null, icon: 'server'
		});
		const [after] = rows();
		assert.deepEqual(rows(), [{
			...before, sourceType: 'external', composePath: null, envPath: null, icon: 'server', updatedAt: after.updatedAt
		}]);
		assert.equal(result.id, before.id);
		assert.equal(result.sourceType, 'external');
		assert.equal(result.composePath, null);
		assert.equal(result.icon, 'server');
	});
});

it('generates the same conditional assignment for PostgreSQL without a server', async () => {
	const queries: Query[] = [];
	const db = pgDrizzle(async (sql, params) => {
		queries.push({ sql, params });
		return { rows: [] };
	});
	const operations = loadOperations(db, pgStackSources);
	assert.equal(await operations.assignStackComposePathFromLabel('app', 1, '/labels/compose.yaml'), false);
	assert.equal(queries.length, 1);
	assertConditionalAssignment(queries[0]);
	assert.match(queries[0].sql, /\$\d+/);
	assert.ok(queries[0].params.includes('/labels/compose.yaml'));
});
