import { useState, useCallback } from 'react';
import { Settings } from './types';

interface AutoSaveOptions {
  settings: Settings;
  whitelist: string[];
  prLabel: string;
  primaryLabels: string[];
  keywords: string[];
  ignoreKeywords: string[];
}

type PerformAutoSave = (options: AutoSaveOptions) => void;

export function useListManagement(
  settings: Settings,
  prLabel: string,
  performAutoSave: PerformAutoSave
) {
  const [whitelist, setWhitelist] = useState<string[]>([]);
  const [newWhitelistItem, setNewWhitelistItem] = useState('');
  const [primaryLabels, setPrimaryLabels] = useState<string[]>([]);
  const [newPrimaryLabel, setNewPrimaryLabel] = useState('');
  const [keywords, setKeywords] = useState<string[]>([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [ignoreKeywords, setIgnoreKeywords] = useState<string[]>([]);
  const [newIgnoreKeyword, setNewIgnoreKeyword] = useState('');

  const addWhitelistItem = useCallback(() => {
    if (!newWhitelistItem.trim() || whitelist.includes(newWhitelistItem.trim())) return;
    const newList = [...whitelist, newWhitelistItem.trim()];
    setWhitelist(newList);
    setNewWhitelistItem('');
    performAutoSave({ settings, whitelist: newList, prLabel, primaryLabels, keywords, ignoreKeywords });
  }, [newWhitelistItem, whitelist, settings, prLabel, primaryLabels, keywords, ignoreKeywords, performAutoSave]);

  const removeWhitelistItem = useCallback((item: string) => {
    const newList = whitelist.filter(i => i !== item);
    setWhitelist(newList);
    performAutoSave({ settings, whitelist: newList, prLabel, primaryLabels, keywords, ignoreKeywords });
  }, [whitelist, settings, prLabel, primaryLabels, keywords, ignoreKeywords, performAutoSave]);

  const addPrimaryLabel = useCallback(() => {
    if (!newPrimaryLabel.trim() || primaryLabels.includes(newPrimaryLabel.trim())) return;
    const newList = [...primaryLabels, newPrimaryLabel.trim()];
    setPrimaryLabels(newList);
    setNewPrimaryLabel('');
    performAutoSave({ settings, whitelist, prLabel, primaryLabels: newList, keywords, ignoreKeywords });
  }, [newPrimaryLabel, primaryLabels, settings, whitelist, prLabel, keywords, ignoreKeywords, performAutoSave]);

  const removePrimaryLabel = useCallback((item: string) => {
    const newList = primaryLabels.filter(i => i !== item);
    setPrimaryLabels(newList);
    performAutoSave({ settings, whitelist, prLabel, primaryLabels: newList, keywords, ignoreKeywords });
  }, [primaryLabels, settings, whitelist, prLabel, keywords, ignoreKeywords, performAutoSave]);

  const addKeyword = useCallback(() => {
    if (!newKeyword.trim() || keywords.includes(newKeyword.trim())) return;
    const newList = [...keywords, newKeyword.trim()];
    setKeywords(newList);
    setNewKeyword('');
    performAutoSave({ settings, whitelist, prLabel, primaryLabels, keywords: newList, ignoreKeywords });
  }, [newKeyword, keywords, settings, whitelist, prLabel, primaryLabels, ignoreKeywords, performAutoSave]);

  const removeKeyword = useCallback((item: string) => {
    const newList = keywords.filter(i => i !== item);
    setKeywords(newList);
    performAutoSave({ settings, whitelist, prLabel, primaryLabels, keywords: newList, ignoreKeywords });
  }, [keywords, settings, whitelist, prLabel, primaryLabels, ignoreKeywords, performAutoSave]);

  const addIgnoreKeyword = useCallback(() => {
    if (!newIgnoreKeyword.trim() || ignoreKeywords.includes(newIgnoreKeyword.trim())) return;
    const newList = [...ignoreKeywords, newIgnoreKeyword.trim()];
    setIgnoreKeywords(newList);
    setNewIgnoreKeyword('');
    performAutoSave({ settings, whitelist, prLabel, primaryLabels, keywords, ignoreKeywords: newList });
  }, [newIgnoreKeyword, ignoreKeywords, settings, whitelist, prLabel, primaryLabels, keywords, performAutoSave]);

  const removeIgnoreKeyword = useCallback((item: string) => {
    const newList = ignoreKeywords.filter(i => i !== item);
    setIgnoreKeywords(newList);
    performAutoSave({ settings, whitelist, prLabel, primaryLabels, keywords, ignoreKeywords: newList });
  }, [ignoreKeywords, settings, whitelist, prLabel, primaryLabels, keywords, performAutoSave]);

  return {
    whitelist, setWhitelist, newWhitelistItem, setNewWhitelistItem,
    primaryLabels, setPrimaryLabels, newPrimaryLabel, setNewPrimaryLabel,
    keywords, setKeywords, newKeyword, setNewKeyword,
    ignoreKeywords, setIgnoreKeywords, newIgnoreKeyword, setNewIgnoreKeyword,
    addWhitelistItem, removeWhitelistItem,
    addPrimaryLabel, removePrimaryLabel,
    addKeyword, removeKeyword,
    addIgnoreKeyword, removeIgnoreKeyword,
  };
}
