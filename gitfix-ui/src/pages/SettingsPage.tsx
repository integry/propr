import React, { useState, useEffect } from 'react';
import { getSettings, updateSettings, getFollowupKeywords, updateFollowupKeywords, getPrLabel, updatePrLabel, getPrimaryProcessingLabels, updatePrimaryProcessingLabels } from '../api/gitfixApi';

interface Settings {
  worker_concurrency: string;
  github_user_whitelist: string;
  pr_label: string;
}

const SettingsPage: React.FC = () => {
  const [settings, setSettings] = useState<Settings>({
    worker_concurrency: '',
    github_user_whitelist: '',
    pr_label: ''
  });
  const [keywords, setKeywords] = useState<string[]>([]);
  const [newKeyword, setNewKeyword] = useState<string>('');
  const [primaryLabels, setPrimaryLabels] = useState<string[]>([]);
  const [newPrimaryLabel, setNewPrimaryLabel] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [keywordsLoading, setKeywordsLoading] = useState<boolean>(true);
  const [prLabelLoading, setPrLabelLoading] = useState<boolean>(true);
  const [primaryLabelsLoading, setPrimaryLabelsLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [keywordsSaving, setKeywordsSaving] = useState<boolean>(false);
  const [prLabelSaving, setPrLabelSaving] = useState<boolean>(false);
  const [primaryLabelsSaving, setPrimaryLabelsSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [keywordsError, setKeywordsError] = useState<string | null>(null);
  const [keywordsSuccess, setKeywordsSuccess] = useState<string | null>(null);
  const [prLabelError, setPrLabelError] = useState<string | null>(null);
  const [prLabelSuccess, setPrLabelSuccess] = useState<string | null>(null);
  const [primaryLabelsError, setPrimaryLabelsError] = useState<string | null>(null);
  const [primaryLabelsSuccess, setPrimaryLabelsSuccess] = useState<string | null>(null);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await getSettings();
        setSettings({
          worker_concurrency: data.worker_concurrency || '',
          github_user_whitelist: (data.github_user_whitelist || []).join(', ')
        });
      } catch (err) {
        setError((err as Error).message || 'Failed to load settings');
      } finally {
        setLoading(false);
      }
    };
    loadSettings();
  }, []);

  useEffect(() => {
    const loadKeywords = async () => {
      try {
        setKeywordsLoading(true);
        setKeywordsError(null);
        const data = await getFollowupKeywords();
        setKeywords(data.followup_keywords || []);
      } catch (err) {
        setKeywordsError((err as Error).message || 'Failed to load keywords');
      } finally {
        setKeywordsLoading(false);
      }
    };
    loadKeywords();
  }, []);

  useEffect(() => {
    const loadPrLabel = async () => {
      try {
        setPrLabelLoading(true);
        setPrLabelError(null);
        const data = await getPrLabel();
        setSettings(prev => ({ ...prev, pr_label: data.pr_label || 'gitfix' }));
      } catch (err) {
        setPrLabelError((err as Error).message || 'Failed to load PR label');
      } finally {
        setPrLabelLoading(false);
      }
    };
    loadPrLabel();
  }, []);

  useEffect(() => {
    const loadPrimaryProcessingLabels = async () => {
      try {
        setPrimaryLabelsLoading(true);
        setPrimaryLabelsError(null);
        const data = await getPrimaryProcessingLabels();
        setPrimaryLabels(data.primary_processing_labels || ['AI']);
      } catch (err) {
        setPrimaryLabelsError((err as Error).message || 'Failed to load primary processing labels');
      } finally {
        setPrimaryLabelsLoading(false);
      }
    };
    loadPrimaryProcessingLabels();
  }, []);

  const handleSettingChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setSettings(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleSaveSettings = async () => {
    try {
      setSaving(true);
      setError(null);
      setSuccess(null);

      const updatedSettings = {
        ...settings,
        github_user_whitelist: settings.github_user_whitelist
          .split(',')
          .map(u => u.trim())
          .filter(u => u.length > 0)
      };

      // Convert worker_concurrency to number if provided
      if (updatedSettings.worker_concurrency) {
        updatedSettings.worker_concurrency = parseInt(updatedSettings.worker_concurrency);
        if (isNaN(updatedSettings.worker_concurrency)) {
          throw new Error('Worker concurrency must be a number');
        }
      } else {
        delete updatedSettings.worker_concurrency;
      }

      await updateSettings(updatedSettings);
      setSuccess('Settings updated successfully! The daemon will pick up changes within 5 minutes.');
    } catch (err) {
      setError((err as Error).message || 'Failed to update settings');
    } finally {
      setSaving(false);
    }
  };

  const handleAddKeyword = () => {
    if (!newKeyword) return;

    if (keywords.includes(newKeyword)) {
      alert(`Keyword "${newKeyword}" has already been added to the list.`);
      return;
    }

    setKeywords([...keywords, newKeyword]);
    setNewKeyword('');
  };

  const handleRemoveKeyword = (keyword: string) => {
    if (confirm(`Are you sure you want to remove the keyword "${keyword}"?`)) {
      setKeywords(keywords.filter(k => k !== keyword));
    }
  };

  const handleAddPrimaryLabel = () => {
    if (!newPrimaryLabel) return;

    if (primaryLabels.includes(newPrimaryLabel)) {
      alert(`Label "${newPrimaryLabel}" has already been added to the list.`);
      return;
    }

    setPrimaryLabels([...primaryLabels, newPrimaryLabel]);
    setNewPrimaryLabel('');
  };

  const handleRemovePrimaryLabel = (label: string) => {
    if (confirm(`Are you sure you want to remove the label "${label}"?`)) {
      setPrimaryLabels(primaryLabels.filter(l => l !== label));
    }
  };

  const handleSaveKeywords = async () => {
    try {
      setKeywordsSaving(true);
      setKeywordsError(null);
      setKeywordsSuccess(null);
      
      await updateFollowupKeywords(keywords);
      setKeywordsSuccess('Keywords updated successfully! The daemon will pick up changes within 5 minutes.');
    } catch (err) {
      setKeywordsError((err as Error).message || 'Failed to update keywords');
    } finally {
      setKeywordsSaving(false);
    }
  };

  const handleSavePrLabel = async () => {
    try {
      setPrLabelSaving(true);
      setPrLabelError(null);
      setPrLabelSuccess(null);

      if (!settings.pr_label || settings.pr_label.trim() === '') {
        setPrLabelError('PR Label cannot be empty');
        return;
      }

      await updatePrLabel(settings.pr_label.trim());
      setPrLabelSuccess('PR Label updated successfully! The worker will pick up changes immediately.');
    } catch (err) {
      setPrLabelError((err as Error).message || 'Failed to update PR label');
    } finally {
      setPrLabelSaving(false);
    }
  };

  const handleSavePrimaryProcessingLabels = async () => {
    try {
      setPrimaryLabelsSaving(true);
      setPrimaryLabelsError(null);
      setPrimaryLabelsSuccess(null);

      if (primaryLabels.length === 0) {
        setPrimaryLabelsError('At least one primary processing label is required');
        return;
      }

      await updatePrimaryProcessingLabels(primaryLabels);
      setPrimaryLabelsSuccess('Primary Processing Labels updated successfully! The daemon will pick up changes within 5 minutes.');
    } catch (err) {
      setPrimaryLabelsError((err as Error).message || 'Failed to update primary processing labels');
    } finally {
      setPrimaryLabelsSaving(false);
    }
  };

  return (
    <div className="max-w-4xl">
      <h2 className="text-gray-900 text-2xl font-semibold mb-8">Settings</h2>
      
      {/* General Settings Section */}
      <div className="mb-8">
        <h3 className="text-gray-900 text-xl font-semibold mb-4">General Settings</h3>
        
        {error && (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-md text-red-700">
            {error}
          </div>
        )}
        
        {success && (
          <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-md text-green-700">
            {success}
          </div>
        )}
        
        {loading ? (
          <p className="text-gray-600">Loading settings...</p>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="block text-gray-700 mb-2" htmlFor="worker_concurrency">
                Worker Concurrency
              </label>
              <input
                type="number"
                id="worker_concurrency"
                name="worker_concurrency"
                value={settings.worker_concurrency}
                onChange={handleSettingChange}
                placeholder="Number of concurrent workers (e.g., 2)"
                className="w-full px-3 py-2 bg-gray-50 text-gray-900 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              />
              <p className="mt-1 text-sm text-gray-600">
                Controls how many issues can be processed simultaneously
              </p>
            </div>

            <div>
              <label className="block text-gray-700 mb-2" htmlFor="github_user_whitelist">
                GitHub User Whitelist
              </label>
              <textarea
                id="github_user_whitelist"
                name="github_user_whitelist"
                value={settings.github_user_whitelist}
                onChange={handleSettingChange}
                rows={3}
                placeholder="Comma-separated list of GitHub usernames (e.g., user1, user2)"
                className="w-full px-3 py-2 bg-gray-800 text-white border border-gray-700 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono text-sm"
              />
              <p className="mt-1 text-sm text-gray-600">
                Only process issues from these GitHub users. Leave empty to process from all users.
              </p>
            </div>

            <button
              onClick={handleSaveSettings}
              disabled={saving}
              className={`px-6 py-3 text-white font-medium rounded-md transition-colors ${
                saving
                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  : 'bg-primary-600 hover:bg-primary-700 cursor-pointer'
              }`}
            >
              {saving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        )}
      </div>

      {/* PR Label Section */}
      <div className="mb-8">
        <h3 className="text-gray-900 text-xl font-semibold mb-4">PR Label</h3>
        <p className="text-gray-600 mb-4">
          Configure the label that will be automatically added to all PRs created by GitFix. 
          Only PRs with this label will be monitored for follow-up comments.
        </p>
        
        {prLabelError && (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-md text-red-700">
            {prLabelError}
          </div>
        )}
        
        {prLabelSuccess && (
          <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-md text-green-700">
            {prLabelSuccess}
          </div>
        )}
        
        {prLabelLoading ? (
          <p className="text-gray-600">Loading PR label...</p>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="block text-gray-700 mb-2" htmlFor="pr_label">
                PR Label <span className="text-red-600">*</span>
              </label>
              <input
                type="text"
                id="pr_label"
                name="pr_label"
                value={settings.pr_label}
                onChange={handleSettingChange}
                placeholder="e.g., gitfix"
                required
                className="w-full px-3 py-2 bg-gray-50 text-gray-900 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              />
              <p className="mt-1 text-sm text-gray-600">
                This label will be added to all PRs created by GitFix and used to filter follow-up comments
              </p>
            </div>

            <button
              onClick={handleSavePrLabel}
              disabled={prLabelSaving || !settings.pr_label || settings.pr_label.trim() === ''}
              className={`px-6 py-3 text-white font-medium rounded-md transition-colors ${
                prLabelSaving || !settings.pr_label || settings.pr_label.trim() === ''
                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  : 'bg-primary-600 hover:bg-primary-700 cursor-pointer'
              }`}
            >
              {prLabelSaving ? 'Saving...' : 'Save PR Label'}
            </button>
          </div>
        )}
      </div>

      {/* Primary Processing Labels Section */}
      <div className="mb-8">
        <h3 className="text-gray-900 text-xl font-semibold mb-4">Primary Processing Labels</h3>
        <p className="text-gray-600 mb-4">
          Configure multiple primary labels that GitFix uses to identify issues for processing. 
          Issues with any of these labels will be automatically processed. State labels (-processing, -done) 
          are dynamically generated based on the specific label found on each issue.
        </p>
        
        {primaryLabelsError && (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-md text-red-700">
            {primaryLabelsError}
          </div>
        )}
        
        {primaryLabelsSuccess && (
          <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-md text-green-700">
            {primaryLabelsSuccess}
          </div>
        )}
        
        {primaryLabelsLoading ? (
          <p className="text-gray-600">Loading primary processing labels...</p>
        ) : (
          <>
            <div className="flex gap-4 mb-4">
              <input
                value={newPrimaryLabel}
                onChange={(e) => setNewPrimaryLabel(e.target.value)}
                onKeyPress={(e: React.KeyboardEvent) => e.key === 'Enter' && handleAddPrimaryLabel()}
                placeholder="Add a label (e.g., AI, gitfix)"
                className="flex-1 px-3 py-2 bg-gray-800 text-white border border-gray-700 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              <button
                onClick={handleAddPrimaryLabel}
                disabled={!newPrimaryLabel || primaryLabels.includes(newPrimaryLabel)}
                className={`px-4 py-2 text-white font-medium rounded-md transition-colors ${
                  !newPrimaryLabel || primaryLabels.includes(newPrimaryLabel)
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : 'bg-green-600 hover:bg-green-700 cursor-pointer'
                }`}
              >
                Add Label
              </button>
            </div>

            <div className="space-y-2 mb-4">
              {primaryLabels.map(label => (
                <div
                  key={label}
                  className="flex items-center justify-between px-4 py-3 bg-gray-50 border border-gray-200 rounded-md"
                >
                  <span className="font-mono text-gray-900">{label}</span>
                  <button
                    onClick={() => handleRemovePrimaryLabel(label)}
                    className="bg-red-600 hover:bg-red-700 text-xs px-3 py-1 text-white rounded-md font-medium transition-colors"
                  >
                    Remove
                  </button>
                </div>
              ))}
              {primaryLabels.length === 0 && (
                <p className="text-gray-600 text-center py-8">
                  No labels configured. Add at least one label to enable issue processing.
                </p>
              )}
            </div>
            <p className="text-sm text-gray-600 mb-4">
              Issues with any of these labels will be processed. For each label, state labels will be 
              automatically generated (e.g., "AI-processing", "AI-done", "gitfix-processing", "gitfix-done")
            </p>
            
            <button
              onClick={handleSavePrimaryProcessingLabels}
              disabled={primaryLabelsSaving || primaryLabels.length === 0}
              className={`px-6 py-3 text-white font-medium rounded-md transition-colors ${
                primaryLabelsSaving || primaryLabels.length === 0
                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  : 'bg-primary-600 hover:bg-primary-700 cursor-pointer'
              }`}
            >
              {primaryLabelsSaving ? 'Saving...' : 'Save Primary Processing Labels'}
            </button>
          </>
        )}
      </div>

      {/* Follow-up Keywords Section */}
      <div>
        <h3 className="text-gray-900 text-xl font-semibold mb-4">Follow-up Keywords</h3>
        <p className="text-gray-600 mb-4">
          When these keywords are found in follow-up comments on issues with the configured AI primary label, 
          the bot will process them automatically.
        </p>
        
        {keywordsError && (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-md text-red-700">
            {keywordsError}
          </div>
        )}
        
        {keywordsSuccess && (
          <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-md text-green-700">
            {keywordsSuccess}
          </div>
        )}
        
        {keywordsLoading ? (
          <p className="text-gray-600">Loading keywords...</p>
        ) : (
          <>
            <div className="flex gap-4 mb-4">
              <input
                value={newKeyword}
                onChange={(e) => setNewKeyword(e.target.value)}
                onKeyPress={(e: React.KeyboardEvent) => e.key === 'Enter' && handleAddKeyword()}
                placeholder="Add a keyword (e.g., GITFIX)"
                className="flex-1 px-3 py-2 bg-gray-800 text-white border border-gray-700 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              <button
                onClick={handleAddKeyword}
                disabled={!newKeyword || keywords.includes(newKeyword)}
                className={`px-4 py-2 text-white font-medium rounded-md transition-colors ${
                  !newKeyword || keywords.includes(newKeyword)
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : 'bg-green-600 hover:bg-green-700 cursor-pointer'
                }`}
              >
                Add Keyword
              </button>
            </div>

            <div className="space-y-2 mb-4">
              {keywords.map(keyword => (
                <div
                  key={keyword}
                  className="flex items-center justify-between px-4 py-3 bg-gray-50 border border-gray-200 rounded-md"
                >
                  <span className="font-mono text-gray-900">{keyword}</span>
                  <button
                    onClick={() => handleRemoveKeyword(keyword)}
                    className="bg-red-600 hover:bg-red-700 text-xs px-3 py-1 text-white rounded-md font-medium transition-colors"
                  >
                    Remove
                  </button>
                </div>
              ))}
              {keywords.length === 0 && (
                <p className="text-gray-600 text-center py-8">
                  No keywords configured. Add a keyword to enable follow-up comment processing.
                </p>
              )}
            </div>
            
            <button
              onClick={handleSaveKeywords}
              disabled={keywordsSaving || keywords.length === 0}
              className={`px-6 py-3 text-white font-medium rounded-md transition-colors ${
                keywordsSaving || keywords.length === 0
                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  : 'bg-primary-600 hover:bg-primary-700 cursor-pointer'
              }`}
            >
              {keywordsSaving ? 'Saving...' : 'Save Keywords'}
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default SettingsPage;