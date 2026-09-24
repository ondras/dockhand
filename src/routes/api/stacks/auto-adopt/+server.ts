import { json } from '@sveltejs/kit';
import { resolve } from 'node:path';
import { authorize } from '$lib/server/authorize';
import { auditStack } from '$lib/server/audit';
import { assignStackComposePathFromLabel, getEnvironment, getStackSources } from '$lib/server/db';
import { evaluateComposePathLabels } from '$lib/server/compose-path-labels';
import { getDefaultStacksDir, getLocalStacksDir, isStacksDirEnvSet, listComposeStacks } from '$lib/server/stacks';
import type { RequestHandler } from './$types';

/**
 * @openapi
 * summary: Automatically assign trusted local Compose path labels to unassigned stacks
 * description: Requires the environment's Trust Compose path labels opt-in and a local socket connection. Registers files without modifying or deploying them. Existing assignments always win.
 * query: env:integer! Environment id
 * resp-200: {results:array<{stackName:string!, status:string!, reason:string, message:string}>!}
 * resp-400: Invalid environment id or unsupported connection type
 * resp-403: Permission denied (needs stacks:create and environment access)
 * resp-404: Environment not found
 * resp-500: Failed to discover or assign stacks
 */
export const POST: RequestHandler = async event => {
	const value = event.url.searchParams.get('env');
	const envId = Number(value);
	if (!value || !Number.isSafeInteger(envId) || envId <= 0) {
		return json({ error: 'A valid environment ID is required' }, { status: 400 });
	}
	const auth = await authorize(event.cookies);
	if (auth.authEnabled && !await auth.can('stacks', 'create', envId)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const denied = await auth.requireEnvAccess(envId);
	if (denied) { return denied; }

	try {
		const env = await getEnvironment(envId);
		if (!env) { return json({ error: 'Environment not found' }, { status: 404 }); }
		if (env.trustComposePathLabels !== true) { return json({ results: [] }); }
		if (env.connectionType && env.connectionType != 'socket') {
			return json({ error: 'Automatic Compose path assignment requires a local Docker socket' }, { status: 400 });
		}

		// Do not trust other environments' staging directories or recent scan locations.
		const roots = [resolve(getDefaultStacksDir(), env.name)];
		if (isStacksDirEnvSet()) { roots.push(getLocalStacksDir()); }
		const stacks = await listComposeStacks(envId);
		const sources = new Map((await getStackSources(envId)).map(source => [source.stackName, source]));
		const results: Array<{ stackName: string; status: 'assigned' | 'preserved' | 'rejected'; reason?: string; message?: string }> = [];
		for (const stack of stacks) {
			const source = sources.get(stack.name);
			if (source && (source.composePath !== null || source.sourceType != 'external' || source.gitRepositoryId !== null || source.gitStackId !== null)) {
				results.push({ stackName: stack.name, status: 'preserved' });
				continue;
			}
			const decision = await evaluateComposePathLabels({
				containerLabels: (stack.containerDetails ?? []).map(container => container.labels ?? {}),
				roots
			});
			if (decision.status == 'rejected') {
				results.push({ stackName: stack.name, ...decision });
				continue;
			}
			const assigned = await assignStackComposePathFromLabel(stack.name, envId, decision.composePath);
			results.push({ stackName: stack.name, status: assigned ? 'assigned' : 'preserved' });
			if (assigned) {
				await auditStack(event, 'create', stack.name, envId, { source: 'compose-path-label', composePath: decision.composePath });
			}
		}
		return json({ results });
	} catch (error) {
		console.error('Error automatically assigning Compose paths:', error);
		return json({ error: 'Failed to discover or assign Compose files' }, { status: 500 });
	}
};
