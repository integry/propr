import React, { useState, useMemo } from 'react';
import {
  FileText,
  FileCode,
  FileJson,
  File,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Plus,
  Minus,
  Trash2,
  ArrowRight
} from 'lucide-react';
import { FileChange } from '../../api/fileChangesApi';

interface FileTreeProps {
  files: FileChange[];
  selectedFile: string | null;
  onSelectFile: (filePath: string) => void;
}

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: TreeNode[];
  file?: FileChange;
  linesAdded: number;
  linesRemoved: number;
}

// Get file icon based on file extension
const getFileIcon = (filePath: string) => {
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
  if (['py'].includes(ext)) {
    return <FileCode className="h-4 w-4 text-green-600" />;
  }
  if (['go'].includes(ext)) {
    return <FileCode className="h-4 w-4 text-cyan-500" />;
  }
  if (['rs'].includes(ext)) {
    return <FileCode className="h-4 w-4 text-orange-500" />;
  }
  if (['css', 'scss', 'sass', 'less'].includes(ext)) {
    return <FileCode className="h-4 w-4 text-pink-500" />;
  }
  return <File className="h-4 w-4 text-gray-400" />;
};

// Get status icon based on file change status
const getStatusIcon = (status: FileChange['status']) => {
  switch (status) {
    case 'added':
      return <Plus className="h-3 w-3 text-green-500" />;
    case 'deleted':
      return <Trash2 className="h-3 w-3 text-red-500" />;
    case 'renamed':
      return <ArrowRight className="h-3 w-3 text-yellow-500" />;
    default:
      return null;
  }
};

// Build tree structure from flat file paths
const buildTree = (files: FileChange[]): TreeNode[] => {
  const root: TreeNode[] = [];

  files.forEach(file => {
    const parts = file.path.split('/');
    let currentLevel = root;

    parts.forEach((part, index) => {
      const isLastPart = index === parts.length - 1;
      const currentPath = parts.slice(0, index + 1).join('/');

      let existingNode = currentLevel.find(node => node.name === part);

      if (!existingNode) {
        const newNode: TreeNode = {
          name: part,
          path: currentPath,
          isDirectory: !isLastPart,
          children: [],
          linesAdded: isLastPart ? file.linesAdded : 0,
          linesRemoved: isLastPart ? file.linesRemoved : 0,
          file: isLastPart ? file : undefined
        };
        currentLevel.push(newNode);
        existingNode = newNode;
      } else if (isLastPart) {
        existingNode.file = file;
        existingNode.linesAdded = file.linesAdded;
        existingNode.linesRemoved = file.linesRemoved;
      }

      currentLevel = existingNode.children;
    });
  });

  // Calculate aggregate line counts for directories
  const calculateAggregate = (nodes: TreeNode[]): { added: number; removed: number } => {
    let totalAdded = 0;
    let totalRemoved = 0;

    nodes.forEach(node => {
      if (node.isDirectory) {
        const childStats = calculateAggregate(node.children);
        node.linesAdded = childStats.added;
        node.linesRemoved = childStats.removed;
        totalAdded += childStats.added;
        totalRemoved += childStats.removed;
      } else {
        totalAdded += node.linesAdded;
        totalRemoved += node.linesRemoved;
      }
    });

    return { added: totalAdded, removed: totalRemoved };
  };

  calculateAggregate(root);

  // Sort: directories first, then alphabetically
  const sortNodes = (nodes: TreeNode[]): TreeNode[] => {
    return nodes.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    }).map(node => ({
      ...node,
      children: sortNodes(node.children)
    }));
  };

  return sortNodes(root);
};

interface TreeNodeItemProps {
  node: TreeNode;
  depth: number;
  selectedFile: string | null;
  onSelectFile: (filePath: string) => void;
  expandedPaths: Set<string>;
  toggleExpanded: (path: string) => void;
}

const TreeNodeItem: React.FC<TreeNodeItemProps> = ({
  node,
  depth,
  selectedFile,
  onSelectFile,
  expandedPaths,
  toggleExpanded
}) => {
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = selectedFile === node.path;

  const handleClick = () => {
    if (node.isDirectory) {
      toggleExpanded(node.path);
    } else {
      onSelectFile(node.path);
    }
  };

  return (
    <div>
      <div
        className={`flex items-center gap-1 py-1 px-2 cursor-pointer rounded hover:bg-gray-100 transition-colors ${
          isSelected ? 'bg-blue-100 hover:bg-blue-100' : ''
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={handleClick}
      >
        {node.isDirectory ? (
          <>
            <span className="text-gray-400">
              {isExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </span>
            {isExpanded ? (
              <FolderOpen className="h-4 w-4 text-yellow-600" />
            ) : (
              <Folder className="h-4 w-4 text-yellow-600" />
            )}
          </>
        ) : (
          <>
            <span className="w-4" /> {/* Spacer for alignment */}
            {getFileIcon(node.path)}
            {node.file && getStatusIcon(node.file.status)}
          </>
        )}
        <span className={`flex-1 text-sm truncate ${isSelected ? 'font-medium text-blue-900' : 'text-gray-700'}`}>
          {node.name}
        </span>
        <div className={`flex items-center gap-1 text-xs font-mono ${node.isDirectory ? 'opacity-50' : ''}`}>
          {node.linesAdded > 0 && (
            <span className="flex items-center text-green-600">
              <Plus className="h-3 w-3" />
              {node.linesAdded}
            </span>
          )}
          {node.linesRemoved > 0 && (
            <span className="flex items-center text-red-500">
              <Minus className="h-3 w-3" />
              {node.linesRemoved}
            </span>
          )}
        </div>
      </div>
      {node.isDirectory && isExpanded && (
        <div>
          {node.children.map(child => (
            <TreeNodeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedFile={selectedFile}
              onSelectFile={onSelectFile}
              expandedPaths={expandedPaths}
              toggleExpanded={toggleExpanded}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const FileTree: React.FC<FileTreeProps> = ({ files, selectedFile, onSelectFile }) => {
  const tree = useMemo(() => buildTree(files), [files]);

  // Initialize all directories as expanded
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    const paths = new Set<string>();
    const collectDirectoryPaths = (nodes: TreeNode[]) => {
      nodes.forEach(node => {
        if (node.isDirectory) {
          paths.add(node.path);
          collectDirectoryPaths(node.children);
        }
      });
    };
    collectDirectoryPaths(tree);
    return paths;
  });

  const toggleExpanded = (path: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  if (files.length === 0) {
    return (
      <div className="text-sm text-gray-500 italic p-4">
        No file changes yet
      </div>
    );
  }

  return (
    <div className="text-sm">
      {tree.map(node => (
        <TreeNodeItem
          key={node.path}
          node={node}
          depth={0}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
          expandedPaths={expandedPaths}
          toggleExpanded={toggleExpanded}
        />
      ))}
    </div>
  );
};

export default FileTree;
