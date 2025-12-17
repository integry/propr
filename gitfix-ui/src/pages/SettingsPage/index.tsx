import React, { useState, useEffect } from 'react';
import {
  getSettings, updateSettings,
  getFollowupKeywords, updateFollowupKeywords,
  getPrLabel, updatePrLabel,
  getPrimaryProcessingLabels, updatePrimaryProcessingLabels,
  getAgents, AgentConfig
} from '../../api/gitfixApi';
import { Settings } from './types';
import GeneralSettingsSection from './GeneralSettingsSection';
import PrLabelSection from './PrLabelSection';
import TagListSection from './TagListSection';

const SettingsPage: React.FC = () => {
  // State
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [globalSuccess, setGlobalSuccess] = useState<string | null>(null);

  // Data State
  const [settings, setSettings] = useState<Settings>({
    worker_concurrency: '',
    analysis_model_fast: '',
    analysis_model_advanced: ''
  });
  const [prLabel, setPrLabel] = useState('');
  
  // Lists
  const [whitelist, setWhitelist] = useState<string[]>([]);
  const [newWhitelistItem, setNewWhitelistItem] = useState('');
  
  const [primaryLabels, setPrimaryLabels] = useState<string[]>([]);
  const [newPrimaryLabel, setNewPrimaryLabel] = useState('');
  
  const [keywords, setKeywords] = useState<string[]>([]);
  const [newKeyword, setNewKeyword] = useState('');
  
  const [agents, setAgents] = useState<AgentConfig[]>([]);

  // Load All Data
  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        const [sData, kData, pLabelData, pLabelsData, aData] = await Promise.all([
          getSettings(),
          getFollowupKeywords(),
          getPrLabel(),
          getPrimaryProcessingLabels(),
          getAgents()
        ]);

        // Parse Settings
        setSettings({
          worker_concurrency: sData.worker_concurrency || '',
          analysis_model_fast: sData.analysis_model_fast || '',
          analysis_model_advanced: sData.analysis_model_advanced || ''
        });
        
        // Parse Whitelist (came as array from API, though UI previously treated as string)
        const whitelistRaw = sData.github_user_whitelist || [];
        setWhitelist(Array.isArray(whitelistRaw) ? whitelistRaw : []);

        setKeywords(kData.followup_keywords || []);
        setPrLabel(pLabelData.pr_label || 'gitfix');
        setPrimaryLabels(pLabelsData.primary_processing_labels || ['AI']);
        setAgents(aData.agents || []);
      } catch (err) {
        setGlobalError((err as Error).message || 'Failed to load settings');
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, []);

  // Handlers
  const handleSaveAll = async () => {
    setSaving(true);
    setGlobalError(null);
    setGlobalSuccess(null);

    try {
      // Validate
      const concurrency = parseInt(settings.worker_concurrency);
      if (isNaN(concurrency)) throw new Error('Worker concurrency must be a number');
      if (!prLabel.trim()) throw new Error('PR Label cannot be empty');
      if (primaryLabels.length === 0) throw new Error('At least one primary processing label is required');

      await Promise.all([
        updateSettings({
          ...settings,
          worker_concurrency: concurrency,
          github_user_whitelist: whitelist
        }),
        updatePrLabel(prLabel),
        updatePrimaryProcessingLabels(primaryLabels),
        updateFollowupKeywords(keywords)
      ]);

      setGlobalSuccess('All settings saved successfully! Changes will be picked up by the daemon shortly.');
      
      // Clear success after 5s
      setTimeout(() => setGlobalSuccess(null), 5000);
    } catch (err) {
      setGlobalError((err as Error).message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  // Helper for Lists
  const addToList = (item: string, list: string[], setList: (l: string[]) => void, clearInput: () => void) => {
    if (!item.trim() || list.includes(item.trim())) return;
    setList([...list, item.trim()]);
    clearInput();
  };

  const removeFromList = (item: string, list: string[], setList: (l: string[]) => void) => {
    setList(list.filter(i => i !== item));
  };

  if (loading) return <div className="p-8 text-center text-gray-500">Loading settings configuration...</div>;

  return (
    <div className="max-w-7xl mx-auto pb-24">
      <div className="flex justify-between items-center mb-8">
        <h2 className="text-gray-900 text-2xl font-semibold">Settings</h2>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column */}
        <div className="space-y-6">
          <GeneralSettingsSection
            settings={settings}
            agents={agents}
            onSettingChange={(e) => setSettings(prev => ({ ...prev, [e.target.name]: e.target.value }))}
          />
          
          <PrLabelSection
            prLabel={prLabel}
            onLabelChange={(e) => setPrLabel(e.target.value)}
          />
        </div>

        {/* Right Column */}
        <div className="space-y-6">
          <TagListSection
            title="Primary Processing Labels"
            description="Issues with these labels will be auto-processed."
            items={primaryLabels}
            newItem={newPrimaryLabel}
            onNewItemChange={setNewPrimaryLabel}
            onAddItem={() => addToList(newPrimaryLabel, primaryLabels, setPrimaryLabels, () => setNewPrimaryLabel(''))}
            onRemoveItem={(item) => removeFromList(item, primaryLabels, setPrimaryLabels)}
            placeholder="e.g., AI"
            emptyMessage="No labels configured."
            helperText="State labels (-processing, -done) are generated automatically."
          />

          <TagListSection
            title="Follow-up Keywords"
            description="Triggers processing when found in comments."
            items={keywords}
            newItem={newKeyword}
            onNewItemChange={setNewKeyword}
            onAddItem={() => addToList(newKeyword, keywords, setKeywords, () => setNewKeyword(''))}
            onRemoveItem={(item) => removeFromList(item, keywords, setKeywords)}
            placeholder="e.g., GITFIX"
            emptyMessage="No keywords configured."
          />

          <TagListSection
            title="GitHub User Whitelist"
            description="Only process issues/comments from these users."
            items={whitelist}
            newItem={newWhitelistItem}
            onNewItemChange={setNewWhitelistItem}
            onAddItem={() => addToList(newWhitelistItem, whitelist, setWhitelist, () => setNewWhitelistItem(''))}
            onRemoveItem={(item) => removeFromList(item, whitelist, setWhitelist)}
            placeholder="e.g., octocat"
            emptyMessage="Allowed for all users (Empty whitelist)."
          />
        </div>
      </div>

      {/* Sticky Footer */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-4 shadow-lg z-50">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex-1 mr-4">
            {globalError && <span className="text-red-600 font-medium">{globalError}</span>}
            {globalSuccess && <span className="text-green-600 font-medium">{globalSuccess}</span>}
          </div>
          <button
            onClick={handleSaveAll}
            disabled={saving}
            className={`px-6 py-2.5 font-medium rounded-md text-white shadow-sm transition-colors ${
              saving ? 'bg-gray-400 cursor-not-allowed' : 'bg-primary-600 hover:bg-primary-700'
            }`}
          >
            {saving ? 'Saving Changes...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsPage;