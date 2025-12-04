import React, { useState, useEffect } from 'react';
import { 
  getSettings, 
  updateSettings, 
  getFollowupKeywords, 
  updateFollowupKeywords, 
  getPrLabel, 
  updatePrLabel, 
  getPrimaryProcessingLabels, 
  updatePrimaryProcessingLabels 
} from '../../api/gitfixApi';
import { Settings } from './types';
import GeneralSettingsSection from './GeneralSettingsSection';
import PrLabelSection from './PrLabelSection';
import TagListSection from './TagListSection';

const SettingsPage: React.FC = () => {
  const [settings, setSettings] = useState<Settings>({
    worker_concurrency: '',
    github_user_whitelist: '',
    analysis_model_fast: '',
    analysis_model_advanced: '',
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
        setSettings(prev => ({
          ...prev,
          worker_concurrency: data.worker_concurrency || '',
          github_user_whitelist: (data.github_user_whitelist || []).join(', '),
          analysis_model_fast: data.analysis_model_fast || 'claude-3-5-haiku-20241022',
          analysis_model_advanced: data.analysis_model_advanced || 'claude-opus-4-20250514'
        }));
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
    setSettings(prev => ({ ...prev, [name]: value }));
  };

  const handleSaveSettings = async () => {
    try {
      setSaving(true);
      setError(null);
      setSuccess(null);

      const updatedSettings: Record<string, unknown> = {
        worker_concurrency: settings.worker_concurrency,
        github_user_whitelist: settings.github_user_whitelist
          .split(',')
          .map(u => u.trim())
          .filter(u => u.length > 0),
        analysis_model_fast: settings.analysis_model_fast,
        analysis_model_advanced: settings.analysis_model_advanced
      };

      if (updatedSettings.worker_concurrency) {
        updatedSettings.worker_concurrency = parseInt(updatedSettings.worker_concurrency as string);
        if (isNaN(updatedSettings.worker_concurrency as number)) {
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

  return (
    <div className="max-w-4xl">
      <h2 className="text-gray-900 text-2xl font-semibold mb-8">Settings</h2>
      
      <GeneralSettingsSection
        settings={settings}
        loading={loading}
        saving={saving}
        error={error}
        success={success}
        onSettingChange={handleSettingChange}
        onSave={handleSaveSettings}
      />

      <PrLabelSection
        prLabel={settings.pr_label}
        loading={prLabelLoading}
        saving={prLabelSaving}
        error={prLabelError}
        success={prLabelSuccess}
        onLabelChange={handleSettingChange}
        onSave={handleSavePrLabel}
      />

      <TagListSection
        title="Primary Processing Labels"
        description="Configure multiple primary labels that GitFix uses to identify issues for processing. Issues with any of these labels will be automatically processed. State labels (-processing, -done) are dynamically generated based on the specific label found on each issue."
        items={primaryLabels}
        newItem={newPrimaryLabel}
        loading={primaryLabelsLoading}
        saving={primaryLabelsSaving}
        error={primaryLabelsError}
        success={primaryLabelsSuccess}
        placeholder="Add a label (e.g., AI, gitfix)"
        emptyMessage="No labels configured. Add at least one label to enable issue processing."
        helperText='Issues with any of these labels will be processed. For each label, state labels will be automatically generated (e.g., "AI-processing", "AI-done", "gitfix-processing", "gitfix-done")'
        onNewItemChange={setNewPrimaryLabel}
        onAddItem={handleAddPrimaryLabel}
        onRemoveItem={handleRemovePrimaryLabel}
        onSave={handleSavePrimaryProcessingLabels}
      />

      <TagListSection
        title="Follow-up Keywords"
        description="When these keywords are found in follow-up comments on issues with the configured AI primary label, the bot will process them automatically."
        items={keywords}
        newItem={newKeyword}
        loading={keywordsLoading}
        saving={keywordsSaving}
        error={keywordsError}
        success={keywordsSuccess}
        placeholder="Add a keyword (e.g., GITFIX)"
        emptyMessage="No keywords configured. Add a keyword to enable follow-up comment processing."
        onNewItemChange={setNewKeyword}
        onAddItem={handleAddKeyword}
        onRemoveItem={handleRemoveKeyword}
        onSave={handleSaveKeywords}
      />
    </div>
  );
};

export default SettingsPage;
