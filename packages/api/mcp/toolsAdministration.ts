import { z } from 'zod';
import { createAdminRoutes } from '../routes/adminRoutes.js';
import { createRepoChatRoutes } from '../routes/repoChatRoutes.js';
import { type McpTool, type ToolDeps, mutationShape, pageShape, repositorySchema, textSchema, ok, workflow } from './tools.js';
import { McpError } from './config.js';
import { callWorkflow } from './adapter.js';

export function addAdministrationTools(tools: McpTool[], deps: ToolDeps): void {
  const { db } = deps;
  const admin = createAdminRoutes({ database: db });
  const permission = 'instance.manage_members' as const;
  tools.push({ name: 'list_instance_members', description: 'List durable instance members. Requires member-administration permission.', scope: 'manage', permission, readOnly: true, schema: z.object(pageShape).strict(), run: async ({ args }) => {
    const members = await db('instance_members').select('github_user_id', 'github_username', 'role', 'source', 'updated_at').orderBy('github_user_id').offset(args.offset).limit(args.limit);
    return ok({ members, nextOffset: members.length === args.limit ? args.offset + args.limit : null });
  } });
  workflow(tools, { name: 'add_instance_member', description: 'Add a verified GitHub user to this instance with an explicit role.', scope: 'manage', permission, schema: z.object({ ...mutationShape, username: z.string().min(1).max(39), role: z.enum(['admin', 'member']) }).strict() }, admin.addMember, args => ({ body: { username: args.username, role: args.role } }));
  workflow(tools, { name: 'set_instance_member_role', description: 'Change an exact numeric GitHub user’s instance role. Existing last-admin protections apply.', scope: 'manage', permission, schema: z.object({ ...mutationShape, githubUserId: z.string().regex(/^\d+$/), role: z.enum(['admin', 'member']) }).strict() }, admin.updateMemberRole, args => ({ params: { githubUserId: args.githubUserId }, body: { role: args.role } }));
  workflow(tools, { name: 'remove_instance_member', description: 'Remove an exact numeric GitHub user’s durable instance membership. Existing last-admin protections apply.', scope: 'manage', permission, schema: z.object({ ...mutationShape, githubUserId: z.string().regex(/^\d+$/) }).strict() }, admin.removeMember, args => ({ params: { githubUserId: args.githubUserId } }));
  workflow(tools, { name: 'get_instance_role_audit', description: 'Read a bounded role-change audit.', scope: 'manage', permission, readOnly: true, schema: z.object({ limit: z.number().int().min(1).max(100).default(20) }).strict() }, admin.listRoleAudit, args => ({ query: { limit: String(args.limit) } }));

  const chat = createRepoChatRoutes();
  tools.push({ name: 'get_repository_chat', description: 'Read the repository’s existing shared chat history in bounded pages.', scope: 'read', readOnly: true, schema: z.object({ repository: repositorySchema, ...pageShape }).strict(), run: async ({ args }) => {
    const messages = await db('repo_chat_messages').where({ repository: args.repository }).select('message_id', 'role', 'content', 'timestamp').orderBy('id').offset(args.offset).limit(args.limit);
    return ok({ messages, nextOffset: messages.length === args.limit ? args.offset + args.limit : null });
  } });
  tools.push({ name: 'save_repository_chat_message', description: 'Save a user message in the repository’s shared chat history. Does not start execution.', scope: 'plan', schema: z.object({ ...mutationShape, repository: repositorySchema, messageId: z.uuid(), content: textSchema }).strict(), run: async ({ principal, args }) => {
    const previous = await db('repo_chat_messages').where({ message_id: args.messageId }).first();
    if (previous) throw new McpError('PRECONDITION_FAILED', 'Message ID already exists. Use a fresh ID for new content.', 409);
    return callWorkflow(chat.saveMessages, principal, { body: { repository: args.repository, messages: [{ id: args.messageId, role: 'user', content: args.content, timestamp: Date.now() }] } });
  } });
  workflow(tools, { name: 'delete_repository_chat_message', description: 'Delete an exact message in the repository’s shared chat history.', scope: 'plan', target: { table: 'repo_chat_messages', column: 'message_id', arg: 'messageId' }, schema: z.object({ ...mutationShape, repository: repositorySchema, messageId: z.uuid() }).strict() }, chat.deleteMessage, args => ({ params: { messageId: args.messageId } }));
}
