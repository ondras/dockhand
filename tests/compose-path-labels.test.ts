import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import { evaluateComposePathLabels, type ComposePathLabelsResult } from '../src/lib/server/compose-path-labels';

const CONFIG_FILES = 'com.docker.compose.project.config_files';
const WORKING_DIR = 'com.docker.compose.project.working_dir';
const labels = (path: string) => ({ [CONFIG_FILES]: path });

describe('evaluateComposePathLabels', () => {
	let scratch: string;
	let root: string;
	let composePath: string;
	let previousDataDir: string | undefined;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), 'compose-path-labels-'));
		root = join(scratch, 'stacks');
		mkdirSync(root);
		composePath = join(root, 'compose.yaml');
		writeFileSync(composePath, 'services: {}\n');
		previousDataDir = process.env.DATA_DIR;
		process.env.DATA_DIR = join(scratch, 'data');
	});

	afterEach(() => {
		if (previousDataDir === undefined) { delete process.env.DATA_DIR; }
		else { process.env.DATA_DIR = previousDataDir; }
		rmSync(scratch, { recursive: true, force: true });
	});

	function evaluate(path = composePath, roots = [root]) {
		return evaluateComposePathLabels({ containerLabels: [labels(path)], roots });
	}

	function expectRejected(result: ComposePathLabelsResult, reason: Extract<ComposePathLabelsResult, { status: 'rejected' }>['reason']) {
		expect(result.status).toBe('rejected');
		if (result.status != 'rejected') { throw new Error('Expected rejection'); }
		expect(result.reason).toBe(reason);
		expect(result.message.length).toBeGreaterThan(0);
		expect(result.message).not.toContain(scratch);
		expect(result.message).not.toContain('SECRET');
		expect(result).not.toHaveProperty('composePath');
	}

	test('accepts consistent labels and returns the normalized absolute path', async () => {
		const result = await evaluateComposePathLabels({
			containerLabels: [labels(`${root}//./compose.yaml`), labels(composePath)],
			roots: [`${root}/`]
		});
		expect(result).toEqual({ status: 'eligible', composePath });
	});

	test.each(['compose.yml', 'custom.YAML', 'compose file.yaml'])(
		'accepts an editable filename: %s', async name => {
			const path = join(root, name);
			writeFileSync(path, 'services: {}');
			expect(await evaluate(path)).toEqual({ status: 'eligible', composePath: path });
		}
	);

	test.each(['false', ' NO ', '0'])('honors adoption opt-out on any container: %s', async value => {
		expectRejected(await evaluateComposePathLabels({
			containerLabels: [labels(composePath), { ...labels(composePath), 'dockhand.adopt': value }],
			roots: [root]
		}), 'adoption_disabled');
	});

	test('adoption opt-out takes precedence over missing paths', async () => {
		expectRejected(await evaluateComposePathLabels({
			containerLabels: [{ 'dockhand.adopt': 'false' }], roots: []
		}), 'adoption_disabled');
	});

	test('requires containers and a label on every container', async () => {
		for (const containerLabels of [[], [{}], [labels(composePath), {}], [{}, labels(composePath)]]) {
			expectRejected(await evaluateComposePathLabels({ containerLabels, roots: [root] }), 'missing_config_files');
		}
	});

	test.each(['', '   '])('rejects an empty label: %j', async value => {
		expectRejected(await evaluate(value), 'missing_config_files');
	});

	test.each([',', ',compose.yaml', 'compose.yaml,', 'a.yaml,,b.yaml', 'a.yaml, ,b.yaml', '/SECRET\0.yaml', '/SECRET\nfile.yaml'])(
		'rejects malformed labels: %j', async value => {
			expectRejected(await evaluate(value), 'malformed_config_files');
		}
	);

	test('rejects multiple paths, even duplicates', async () => {
		for (const second of [composePath, join(root, 'override.yaml')]) {
			expectRejected(await evaluate(`${composePath},${second}`), 'multiple_config_files');
		}
	});

	test('rejects stdin', async () => {
		expectRejected(await evaluate('-'), 'stdin_config');
	});

	test.each(['compose.yaml', './compose.yaml', '../compose.yaml', '~/compose.yaml', 'https://SECRET/compose.yaml'])(
		'rejects non-absolute paths without mapping: %s', async value => {
			expectRejected(await evaluate(value), 'relative_config_path');
		}
	);

	test('rejects conflicting containers', async () => {
		expectRejected(await evaluateComposePathLabels({
			containerLabels: [labels(composePath), labels(join(root, 'other.yaml'))], roots: [root]
		}), 'conflicting_config_paths');
	});

	test('allows missing working directories and repeated matching labels with symlink aliases', async () => {
		const alias = join(scratch, 'project-alias');
		symlinkSync(root, alias);
		for (const path of [composePath, join(alias, 'compose.yaml')]) {
			expect(await evaluateComposePathLabels({
				containerLabels: [
					labels(path),
					{ ...labels(path), [WORKING_DIR]: root },
					{ ...labels(path), [WORKING_DIR]: root },
					{ ...labels(path), [WORKING_DIR]: `${root}//./` },
					{ ...labels(path), [WORKING_DIR]: alias }
				],
				roots: [root]
			})).toEqual({ status: 'eligible', composePath: path });
		}
	});

	test.each(['', ' ', '.', '../app', '~/app', '/SECRET\0project'])(
		'rejects invalid working directories: %j', async workingDirectory => {
			expectRejected(await evaluateComposePathLabels({
				containerLabels: [{ ...labels(composePath), [WORKING_DIR]: workingDirectory }], roots: [root]
			}), 'working_directory_mismatch');
		}
	);

	test('rejects unavailable working directories and file paths', async () => {
		const missing = join(root, 'SECRET-missing');
		const dangling = join(root, 'dangling');
		symlinkSync(missing, dangling);
		for (const workingDirectory of [missing, dangling, composePath]) {
			expectRejected(await evaluateComposePathLabels({
				containerLabels: [{ ...labels(composePath), [WORKING_DIR]: workingDirectory }], roots: [root]
			}), 'working_directory_mismatch');
		}
	});

	test('rejects custom parent, sibling and outside project directories on any container', async () => {
		const project = join(root, 'app');
		const config = join(project, 'config');
		const sibling = join(project, 'sibling');
		const outside = join(scratch, 'outside');
		for (const directory of [config, sibling, outside]) { mkdirSync(directory, { recursive: true }); }
		const path = join(config, 'compose.yaml');
		writeFileSync(path, 'services: {}');
		const matching = { ...labels(path), [WORKING_DIR]: config };
		for (const workingDirectory of [project, sibling, outside]) {
			const conflicting = { ...labels(path), [WORKING_DIR]: workingDirectory };
			for (const containerLabels of [[matching, conflicting], [conflicting, matching]]) {
				expectRejected(await evaluateComposePathLabels({ containerLabels, roots: [root] }), 'working_directory_mismatch');
			}
		}
	});

	test('compares working directory with the advertised filename parent, not the symlink target parent', async () => {
		const project = join(root, 'project');
		mkdirSync(project);
		const link = join(project, 'compose.yaml');
		symlinkSync(composePath, link);
		expect(await evaluateComposePathLabels({
			containerLabels: [{ ...labels(link), [WORKING_DIR]: project }], roots: [root]
		})).toEqual({ status: 'eligible', composePath: link });
		expectRejected(await evaluateComposePathLabels({
			containerLabels: [{ ...labels(link), [WORKING_DIR]: root }], roots: [root]
		}), 'working_directory_mismatch');
	});

	test.each(['compose', 'compose.json', 'compose.yaml.bak'])(
		'rejects unsupported filename: %s', async name => {
			const path = join(root, name);
			writeFileSync(path, 'services: {}');
			expectRejected(await evaluate(path), 'unsupported_extension');
		}
	);

	test('rejects missing files and dangling symlinks', async () => {
		const missing = join(root, 'SECRET.yaml');
		expectRejected(await evaluate(missing), 'file_unavailable');
		const link = join(root, 'dangling.yaml');
		symlinkSync(missing, link);
		expectRejected(await evaluate(link), 'file_unavailable');
	});

	test('rejects directories and a base directory outside the root', async () => {
		const directory = join(root, 'directory.yaml');
		mkdirSync(directory);
		expectRejected(await evaluate(directory), 'not_regular_file');
		expectRejected(await evaluate(directory, [directory]), 'outside_roots');
	});

	test('fails closed with no usable allowed roots', async () => {
		for (const roots of [[], ['.'], [join(scratch, 'missing')], [composePath]]) {
			expectRejected(await evaluate(composePath, roots), 'outside_roots');
		}
	});

	test('allows any available matching root, canonicalizing symlinked roots', async () => {
		const alias = join(scratch, 'root-alias');
		symlinkSync(root, alias);
		expect(await evaluate(composePath, [join(scratch, 'missing'), alias])).toEqual({ status: 'eligible', composePath });
		const aliasPath = join(alias, 'compose.yaml');
		expect(await evaluate(aliasPath)).toEqual({ status: 'eligible', composePath: aliasPath });
	});

	test('rejects sibling-prefix and parent-traversal escapes', async () => {
		const sibling = `${root}-other`;
		mkdirSync(sibling);
		const outside = join(sibling, 'compose.yaml');
		writeFileSync(outside, 'services: {}');
		expectRejected(await evaluate(outside), 'outside_roots');
		expectRejected(await evaluate(`${root}/../stacks-other/compose.yaml`), 'outside_roots');
		expectRejected(await evaluate(composePath, [sibling]), 'outside_roots');
	});

	test('rejects filename and ancestor symlinks escaping the roots', async () => {
		const outside = join(scratch, 'outside');
		mkdirSync(outside);
		const target = join(outside, 'compose.yaml');
		writeFileSync(target, 'services: {}');
		const fileLink = join(root, 'file-link.yaml');
		const dirLink = join(root, 'dir-link');
		symlinkSync(target, fileLink);
		symlinkSync(outside, dirLink);
		expectRejected(await evaluate(fileLink), 'outside_roots');
		expectRejected(await evaluate(join(dirLink, 'compose.yaml')), 'outside_roots');
	});

	test('rejects an outside filename symlink pointing into an allowed root', async () => {
		const outside = `${root}-outside`;
		mkdirSync(outside);
		const link = join(outside, 'compose.yaml');
		symlinkSync(composePath, link);
		expectRejected(await evaluate(link), 'outside_roots');
		// Separate allowed roots cannot jointly authorize the target and base directory.
		expectRejected(await evaluate(link, [root, outside]), 'outside_roots');
		expectRejected(await evaluate(link, [outside, root]), 'outside_roots');
		expect(await evaluate(link, [scratch])).toEqual({ status: 'eligible', composePath: link });

		const directoryLink = join(root, 'outside-link');
		symlinkSync(outside, directoryLink);
		expectRejected(await evaluate(join(directoryLink, 'compose.yaml')), 'outside_roots');
	});

	test('allows filesystem root containment using path.relative', async () => {
		expect(await evaluate(composePath, ['/'])).toEqual({ status: 'eligible', composePath });
	});

	test('preserves filename symlink directory for Compose relative paths', async () => {
		const project = join(root, 'project');
		mkdirSync(project);
		const link = join(project, 'compose.yaml');
		symlinkSync(composePath, link);
		const result = await evaluate(`${project}//./compose.yaml`);
		expect(result).toEqual({ status: 'eligible', composePath: normalize(link) });
		if (result.status != 'eligible') { throw new Error('Expected eligibility'); }
		// Returning the canonical filename would incorrectly relocate ./data to root/data.
		expect(resolve(dirname(result.composePath), './data')).toBe(join(project, 'data'));
		expect(resolve(dirname(result.composePath), './data')).not.toBe(join(root, 'data'));
		expectRejected(await evaluateComposePathLabels({
			containerLabels: [labels(link), labels(composePath)], roots: [root]
		}), 'conflicting_config_paths');
	});

	test.each(['.git', '.ssh', 'db', 'deploy-logs'])(
		'rejects protected locations and aliases even within allowed roots: %s', async segment => {
			const protectedDir = join(process.env.DATA_DIR!, segment);
			mkdirSync(protectedDir, { recursive: true });
			const target = join(protectedDir, 'SECRET.yaml');
			writeFileSync(target, 'SECRET');
			const link = join(root, 'alias.yaml');
			symlinkSync(target, link);
			expectRejected(await evaluate(target, [scratch]), 'protected_path');
			expectRejected(await evaluate(link, [scratch]), 'protected_path');
		}
	);

	test('rejects a YAML alias of the encryption key', async () => {
		mkdirSync(process.env.DATA_DIR!);
		const key = join(process.env.DATA_DIR!, '.encryption_key');
		writeFileSync(key, 'SECRET');
		const link = join(root, 'key.yaml');
		symlinkSync(key, link);
		expectRejected(await evaluate(link, [scratch]), 'protected_path');
	});

	test('does not require reading or parsing even a huge sparse file', async () => {
		truncateSync(composePath, 1024 * 1024 * 1024);
		expect(await evaluate()).toEqual({ status: 'eligible', composePath });
	});

	test.skipIf(process.getuid?.() == 0)('rejects an unreadable regular file', async () => {
		chmodSync(composePath, 0o000);
		try {
			expectRejected(await evaluate(), 'file_unreadable');
		} finally {
			chmodSync(composePath, 0o600);
		}
	});
});
