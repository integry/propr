import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ListPlus, Check, ChevronDown, ExternalLink } from 'lucide-react';
import { createTodo, getCategories, RepoTodoCategory } from '../api/repoTodosApi';
import { getRepoConfig } from '../api/proprApi';
import { MonitoredRepo } from '../api/proprTypes';

interface QuickAddTodoProps {
  externalOpen?: boolean;
  onExternalOpenHandled?: () => void;
}

const QuickAddTodo: React.FC<QuickAddTodoProps> = ({ externalOpen, onExternalOpenHandled }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [repos, setRepos] = useState<MonitoredRepo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState('');
  const [content, setContent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [repoDropdownOpen, setRepoDropdownOpen] = useState(false);
  const [categories, setCategories] = useState<RepoTodoCategory[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [categoryDropdownOpen, setCategoryDropdownOpen] = useState(false);
  const [lastUsedCategory, setLastUsedCategory] = useState<Record<string, string>>({});

  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const repoDropdownRef = useRef<HTMLDivElement>(null);
  const categoryDropdownRef = useRef<HTMLDivElement>(null);

  // Infer active repo from URL path
  const inferRepoFromUrl = useCallback((): string => {
    const path = location.pathname;
    // Match /summaries/:owner/:repo pattern
    const summaryMatch = path.match(/^\/summaries\/([^/]+\/[^/]+)/);
    if (summaryMatch) return summaryMatch[1];
    return '';
  }, [location.pathname]);

  // Load repos when popover opens
  useEffect(() => {
    if (!isOpen) return;
    getRepoConfig().then(data => {
      const enabledRepos = data.repos_to_monitor.filter(r => r.enabled);
      setRepos(enabledRepos);
      const inferred = inferRepoFromUrl();
      if (inferred) {
        const match = enabledRepos.find(r => r.name === inferred);
        if (match) setSelectedRepo(match.name);
        else if (enabledRepos.length > 0) setSelectedRepo(enabledRepos[0].name);
      } else if (enabledRepos.length > 0 && !selectedRepo) {
        setSelectedRepo(enabledRepos[0].name);
      }
    }).catch(() => {});
    // Focus textarea after opening
    setTimeout(() => textareaRef.current?.focus(), 100);
  }, [isOpen, inferRepoFromUrl, selectedRepo]);

  // Handle external open trigger (keyboard shortcut)
  useEffect(() => {
    if (externalOpen && !isOpen) {
      setIsOpen(true);
      onExternalOpenHandled?.();
    }
  }, [externalOpen, isOpen, onExternalOpenHandled]);

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        resetForm();
      }
    };
    if (isOpen) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  // Load categories when selected repo changes
  useEffect(() => {
    if (!selectedRepo) {
      setCategories([]);
      setSelectedCategoryId(null);
      return;
    }
    getCategories(selectedRepo).then(cats => {
      setCategories(cats);
      // Use last used category for this repo, or default to uncategorized
      const lastUsed = lastUsedCategory[selectedRepo];
      if (lastUsed && cats.some(c => c.categoryId === lastUsed)) {
        setSelectedCategoryId(lastUsed);
      } else {
        setSelectedCategoryId(null);
      }
    }).catch(() => {
      setCategories([]);
      setSelectedCategoryId(null);
    });
  }, [selectedRepo, lastUsedCategory]);

  // Click outside repo dropdown to close it
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (repoDropdownRef.current && !repoDropdownRef.current.contains(e.target as Node)) {
        setRepoDropdownOpen(false);
      }
    };
    if (repoDropdownOpen) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [repoDropdownOpen]);

  // Click outside category dropdown to close it
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (categoryDropdownRef.current && !categoryDropdownRef.current.contains(e.target as Node)) {
        setCategoryDropdownOpen(false);
      }
    };
    if (categoryDropdownOpen) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [categoryDropdownOpen]);

  const resetForm = () => {
    setContent('');
    setShowSuccess(false);
  };

  const handleSubmit = async () => {
    if (!content.trim() || !selectedRepo || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await createTodo({
        repository: selectedRepo,
        content: content.trim(),
        categoryId: selectedCategoryId,
      });
      // Remember last used category for this repo
      if (selectedCategoryId) {
        setLastUsedCategory(prev => ({ ...prev, [selectedRepo]: selectedCategoryId }));
      }
      setShowSuccess(true);
      setTimeout(() => {
        setIsOpen(false);
        resetForm();
        setIsSubmitting(false);
      }, 1200);
    } catch {
      setIsSubmitting(false);
    }
  };

  const getRepoDisplayName = (name: string): string => {
    const parts = name.split('/');
    return parts.length > 1 ? parts[1] : name;
  };

  return (
    <div className="relative" ref={containerRef}>
      {/* Ghost Button Trigger */}
      <button
        onClick={() => {
          setIsOpen(!isOpen);
          if (isOpen) resetForm();
        }}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition-colors"
        aria-label="Quick add to-do"
      >
        <ListPlus className="w-4 h-4" />
        <span className="hidden lg:inline">To-Do</span>
      </button>

      {/* Popover */}
      {isOpen && (
        <div
          className="absolute right-0 top-full mt-1 w-[320px] bg-white border border-slate-200 shadow-xl z-50"
          style={{ minWidth: '320px' }}
        >
          {showSuccess ? (
            /* Success State */
            <div className="flex flex-col items-center justify-center py-8 gap-2">
              <div className="w-10 h-10 rounded-full bg-green-50 flex items-center justify-center">
                <Check className="w-5 h-5 text-green-600" />
              </div>
              <span className="text-sm font-medium text-green-700">To-Do added</span>
            </div>
          ) : (
            /* Form */
            <div className="p-3 space-y-3">
              {/* Repository Selector */}
              <div className="relative" ref={repoDropdownRef}>
                <button
                  onClick={() => setRepoDropdownOpen(!repoDropdownOpen)}
                  className="flex items-center gap-1.5 px-2 py-1 bg-slate-50 border border-slate-200 hover:border-slate-300 transition-colors w-full text-left"
                >
                  <span className="text-xs font-mono text-slate-700 truncate flex-1">
                    {selectedRepo ? getRepoDisplayName(selectedRepo) : 'Select repo...'}
                  </span>
                  <ChevronDown className="w-3 h-3 text-slate-400 flex-shrink-0" />
                </button>
                {repoDropdownOpen && repos.length > 0 && (
                  <div className="absolute left-0 right-0 top-full mt-0.5 bg-white border border-slate-200 shadow-lg z-[60] max-h-[200px] overflow-y-auto">
                    {repos.map(repo => (
                      <button
                        key={repo.id}
                        onClick={() => {
                          setSelectedRepo(repo.name);
                          setRepoDropdownOpen(false);
                        }}
                        className={`w-full text-left px-2 py-1.5 text-xs font-mono hover:bg-slate-50 transition-colors ${
                          selectedRepo === repo.name ? 'bg-slate-50 text-teal-700' : 'text-slate-700'
                        }`}
                      >
                        {repo.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Textarea */}
              <textarea
                ref={textareaRef}
                value={content}
                onChange={e => setContent(e.target.value)}
                placeholder="Describe your idea..."
                className="w-full border-0 outline-none resize-none text-sm font-sans text-slate-900 placeholder:text-slate-400 min-h-[80px]"
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
              />

              {/* Category Selector (only when repo has categories) */}
              {categories.length > 0 && (
                <div className="relative" ref={categoryDropdownRef}>
                  <button
                    onClick={() => setCategoryDropdownOpen(!categoryDropdownOpen)}
                    className="flex items-center gap-1.5 px-2 py-1 bg-slate-50 border border-slate-200 hover:border-slate-300 transition-colors w-full text-left"
                  >
                    <span className="text-xs text-slate-700 truncate flex-1">
                      {selectedCategoryId
                        ? categories.find(c => c.categoryId === selectedCategoryId)?.name ?? 'Uncategorized'
                        : 'Uncategorized'}
                    </span>
                    <ChevronDown className="w-3 h-3 text-slate-400 flex-shrink-0" />
                  </button>
                  {categoryDropdownOpen && (
                    <div className="absolute left-0 right-0 top-full mt-0.5 bg-white border border-slate-200 shadow-lg z-[60] max-h-[200px] overflow-y-auto">
                      <button
                        onClick={() => {
                          setSelectedCategoryId(null);
                          setCategoryDropdownOpen(false);
                        }}
                        className={`w-full text-left px-2 py-1.5 text-xs hover:bg-slate-50 transition-colors ${
                          selectedCategoryId === null ? 'bg-slate-50 text-teal-700' : 'text-slate-700'
                        }`}
                      >
                        Uncategorized
                      </button>
                      {categories.map(cat => (
                        <button
                          key={cat.categoryId}
                          onClick={() => {
                            setSelectedCategoryId(cat.categoryId);
                            setCategoryDropdownOpen(false);
                          }}
                          className={`w-full text-left px-2 py-1.5 text-xs hover:bg-slate-50 transition-colors ${
                            selectedCategoryId === cat.categoryId ? 'bg-slate-50 text-teal-700' : 'text-slate-700'
                          }`}
                        >
                          {cat.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Actions Row */}
              <div className="flex items-center justify-between pt-1 border-t border-slate-100">
                <button
                  onClick={() => {
                    if (selectedRepo) {
                      setIsOpen(false);
                      resetForm();
                      navigate('/repositories', { state: { selectRepo: selectedRepo, activeTab: 'todos' } });
                    }
                  }}
                  disabled={!selectedRepo}
                  className="flex items-center gap-1 text-xs text-slate-500 hover:text-teal-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <ExternalLink className="w-3 h-3" />
                  <span>View Todos</span>
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={!content.trim() || !selectedRepo || isSubmitting}
                  className="px-3 py-1 bg-teal-600 text-white text-xs font-medium hover:bg-teal-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Add To-Do
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default QuickAddTodo;
