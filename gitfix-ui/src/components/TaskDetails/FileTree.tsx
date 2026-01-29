import React, { useState, useMemo } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileCode,
  FileJson,
  FileText,
  File,
  Folder,
  FolderOpen,
  Plus,
  Minus,
  Trash2
} from 'lucide-react';
import { FileChange } from '../../api/fileChangesApi';

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: Map<string, TreeNode>;
  fileChange?: FileChange;
  linesAdded: number;
  linesRemoved: number;
}

interface FileTreeProps {
  files: FileChange[];
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
}

// Get file icon based on file extension
const getFileIcon = (filePath: string, status?: string) => {
  if (status === 'deleted') {
    return <Trash2 className="h-4 w-4 text-red-500" />;
  }

  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
    return <FileCode className="h-4 w-4 text-blue-500" />;
  }
  if (['json', 'yaml', 'yml'].includes(ext)) {
    return <FileJson className="h-4 w-4 text-yellow-500" />;
  }
  if (['md', 'txt', 'env'].includes(ext)) {
    return <FileText className="h-4 w-4 text-gray-500" />;
  }
  return <File className="h-4 w-4 text-gray-400" />;
};

// Build tree structure from flat file paths
const buildFileTree = (files: FileChange[]): TreeNode => {
  const root: TreeNode = {
    name: '',
    path: '',
    isDirectory: true,
    children: new Map(),
    linesAdded: 0,
    linesRemoved: 0
  };

  for (const file of files) {
    const parts = file.path.split('/');
    let currentNode = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const currentPath = parts.slice(0, i + 1).join('/');

      if (!currentNode.children.has(part)) {
        currentNode.children.set(part, {
          name: part,
          path: currentPath,
          isDirectory: !isLast,
          children: new Map(),
          fileChange: isLast ? file : undefined,
          linesAdded: isLast ? file.linesAdded : 0,
          linesRemoved: isLast ? file.linesRemoved : 0
        });
      }

      const childNode = currentNode.children.get(part)!;

      // Accumulate line counts up the tree
      if (isLast) {
        // Walk back up and update parent totals
        let parent = root;
        for (let j = 0; j < parts.length - 1; j++) {
          const p = parent.children.get(parts[j])!;
          p.linesAdded += file.linesAdded;
          p.linesRemoved += file.linesRemoved;
          parent = p;
        }
        root.linesAdded += file.linesAdded;
        root.linesRemoved += file.linesRemoved;
      }

      currentNode = childNode;
    }
  }

  return root;
};

// Sort children: directories first, then alphabetically
const getSortedChildren = (node: TreeNode): TreeNode[] => {
  const children = Array.from(node.children.values());
  return children.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });
};

interface TreeNodeComponentProps {
  node: TreeNode;
  depth: number;
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  defaultExpanded?: boolean;
}

const TreeNodeComponent: React.FC<TreeNodeComponentProps> = ({
  node,
  depth,
  selectedFile,
  onSelectFile,
  defaultExpanded = true
}) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const hasChanges = node.linesAdded > 0 || node.linesRemoved > 0;

  if (node.isDirectory) {
    const sortedChildren = getSortedChildren(node);

    return (
      <div>
        <div
          className={`flex items-center gap-1 py-1 px-2 cursor-pointer hover:bg-gray-100 rounded ${
            depth === 0 ? '' : 'ml-' + Math.min(depth * 4, 12)
          }`}
          style={{ marginLeft: depth > 0 ? `${depth * 16}px` : 0 }}
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <span className="flex-shrink-0 text-gray-400">
            {isExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </span>
          <span className="flex-shrink-0">
            {isExpanded ? (
              <FolderOpen className="h-4 w-4 text-yellow-600" />
            ) : (
              <Folder className="h-4 w-4 text-yellow-600" />
            )}
          </span>
          <span className="text-sm text-gray-700 truncate flex-1">{node.name || '/'}</span>
          {hasChanges && (
            <span className="flex items-center gap-1 text-xs">
              {node.linesAdded > 0 && (
                <span className="flex items-center text-green-600">
                  <Plus className="h-3 w-3" />
                  {node.linesAdded}
                </span>
              )}
              {node.linesRemoved > 0 && (
                <span className="flex items-center text-red-600">
                  <Minus className="h-3 w-3" />
                  {node.linesRemoved}
                </span>
              )}
            </span>
          )}
        </div>
        {isExpanded && (
          <div>
            {sortedChildren.map((child) => (
              <TreeNodeComponent
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedFile={selectedFile}
                onSelectFile={onSelectFile}
                defaultExpanded={defaultExpanded}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // File node
  const isSelected = selectedFile === node.path;
  const fileStatus = node.fileChange?.status;

  return (
    <div
      className={`flex items-center gap-1 py-1 px-2 cursor-pointer rounded transition-colors ${
        isSelected
          ? 'bg-blue-100 border-l-2 border-blue-500'
          : 'hover:bg-gray-100'
      } ${fileStatus === 'added' ? 'bg-green-50' : ''} ${
        fileStatus === 'deleted' ? 'bg-red-50' : ''
      }`}
      style={{ marginLeft: `${depth * 16}px` }}
      onClick={() => onSelectFile(node.path)}
    >
      <span className="flex-shrink-0 w-4" /> {/* Spacing for alignment with folders */}
      <span className="flex-shrink-0">{getFileIcon(node.name, fileStatus)}</span>
      <span
        className={`text-sm truncate flex-1 ${
          fileStatus === 'deleted' ? 'line-through text-red-600' : 'text-gray-700'
        } ${fileStatus === 'added' ? 'text-green-700' : ''}`}
      >
        {node.name}
      </span>
      <span className="flex items-center gap-1 text-xs">
        {node.linesAdded > 0 && (
          <span className="flex items-center text-green-600">
            <Plus className="h-3 w-3" />
            {node.linesAdded}
          </span>
        )}
        {node.linesRemoved > 0 && (
          <span className="flex items-center text-red-600">
            <Minus className="h-3 w-3" />
            {node.linesRemoved}
          </span>
        )}
      </span>
    </div>
  );
};

const FileTree: React.FC<FileTreeProps> = ({ files, selectedFile, onSelectFile }) => {
  const tree = useMemo(() => buildFileTree(files), [files]);
  const sortedChildren = useMemo(() => getSortedChildren(tree), [tree]);

  if (files.length === 0) {
    return (
      <div className="text-sm text-gray-500 italic p-2">
        No files changed yet
      </div>
    );
  }

  return (
    <div className="text-sm font-mono">
      {sortedChildren.map((child) => (
        <TreeNodeComponent
          key={child.path}
          node={child}
          depth={0}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
          defaultExpanded={true}
        />
      ))}
    </div>
  );
};

export default FileTree;
