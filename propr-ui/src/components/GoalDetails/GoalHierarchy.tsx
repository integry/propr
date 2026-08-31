import { ExternalLink } from 'lucide-react';
import type { GoalHierarchyNodeV1, GoalProviderTodoV1 } from '../../api/goalContracts';
import { hierarchyChildren } from './goalDetailUtils';

const safeUrl = (value: string | null): string | null => {
  if (!value) return null;
  try { const parsed = new URL(value); return parsed.protocol === 'https:' ? value : null; } catch { return null; }
};

const statusTone: Record<GoalHierarchyNodeV1['state'], string> = {
  pending: 'bg-slate-100 text-slate-700', ready: 'bg-blue-100 text-blue-700', active: 'bg-green-100 text-green-700',
  blocked: 'bg-amber-100 text-amber-800', failed: 'bg-red-100 text-red-700', completed: 'bg-teal-100 text-teal-700', cancelled: 'bg-gray-100 text-gray-500',
};

interface HierarchyProps {
  nodes: GoalHierarchyNodeV1[];
  dependencies: Array<{ nodeId: string; dependsOnNodeId: string }>;
  providerTodos: GoalProviderTodoV1[];
}

export default function GoalHierarchy({ nodes, dependencies, providerTodos }: HierarchyProps) {
  const children = hierarchyChildren(nodes);
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const renderNodes = (parentId: string | null, depth = 0) => (children.get(parentId) ?? []).map(node => {
    const url = safeUrl(node.externalUrl);
    const blockedBy = dependencies.filter(item => item.nodeId === node.nodeId).map(item => byId.get(item.dependsOnNodeId)?.title).filter(Boolean);
    return (
      <li key={node.nodeId} role="treeitem" aria-expanded={(children.get(node.nodeId)?.length ?? 0) > 0 || undefined} className={depth > 0 ? 'ml-4 border-l border-slate-200 pl-3' : ''}>
        <div className="my-1.5 rounded-md border border-slate-200 bg-white p-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{node.kind.replace(/_/g, ' ')}</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone[node.state]}`}>{node.state}</span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">{node.title}</span>
            {url && <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${node.title}`} className="rounded p-1 text-slate-400 hover:text-teal-600"><ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /></a>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500">
            <span>CI: {node.ci}</span><span>Review: {node.review}</span><span>Ultrafix: {node.ultrafix}</span><span>Merge: {node.merge}</span>
          </div>
          {(node.blockedReason || blockedBy.length > 0) && <p className="mt-1 text-xs text-amber-700">Blocked{blockedBy.length > 0 ? ` by ${blockedBy.join(', ')}` : ''}{node.blockedReason ? `: ${node.blockedReason}` : ''}</p>}
        </div>
        {(children.get(node.nodeId)?.length ?? 0) > 0 && <ul role="group">{renderNodes(node.nodeId, depth + 1)}</ul>}
      </li>
    );
  });
  return (
    <section aria-labelledby="goal-checklist-title" className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <h2 id="goal-checklist-title" className="text-sm font-semibold text-slate-800">Authoritative ProPR checklist</h2>
      <ul role="tree" aria-label="Goal work hierarchy" className="mt-2">{renderNodes(null)}</ul>
      {nodes.length === 0 && <p className="mt-2 text-xs text-slate-500">The controller has not created work items yet.</p>}
      <div className="mt-4 border-t border-dashed border-slate-300 pt-3" aria-labelledby="provider-todos-title">
        <h3 id="provider-todos-title" className="text-xs font-semibold text-violet-800">Provider advisory todos</h3>
        <p className="mt-0.5 text-[11px] text-slate-500">Advisory only · these do not change the authoritative ProPR checklist.</p>
        {providerTodos.length === 0 ? <p className="mt-2 text-xs text-slate-400">No provider todos reported.</p> : (
          <ul className="mt-2 space-y-1.5">
            {providerTodos.map(todo => <li key={todo.todoId} className="flex gap-2 text-xs text-slate-700"><span aria-hidden="true">{todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◉' : '○'}</span><span><span className="font-medium">{todo.provider}:</span> {todo.content}</span></li>)}
          </ul>
        )}
      </div>
    </section>
  );
}
