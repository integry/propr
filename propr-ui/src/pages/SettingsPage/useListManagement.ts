import { useState, useCallback } from 'react';
type SaveWhitelist = (whitelist: string[]) => void;
type SavePrimaryLabels = (primaryLabels: string[]) => void;
type SaveKeywords = (keywords: string[]) => void;
type SaveIgnoreKeywords = (ignoreKeywords: string[]) => void;

export function useListManagement(
  saveWhitelist: SaveWhitelist,
  savePrimaryLabels: SavePrimaryLabels,
  saveKeywords: SaveKeywords,
  saveIgnoreKeywords: SaveIgnoreKeywords
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
    saveWhitelist(newList);
  }, [newWhitelistItem, whitelist, saveWhitelist]);

  const removeWhitelistItem = useCallback((item: string) => {
    const newList = whitelist.filter(i => i !== item);
    setWhitelist(newList);
    saveWhitelist(newList);
  }, [whitelist, saveWhitelist]);

  const addPrimaryLabel = useCallback(() => {
    if (!newPrimaryLabel.trim() || primaryLabels.includes(newPrimaryLabel.trim())) return;
    const newList = [...primaryLabels, newPrimaryLabel.trim()];
    setPrimaryLabels(newList);
    setNewPrimaryLabel('');
    savePrimaryLabels(newList);
  }, [newPrimaryLabel, primaryLabels, savePrimaryLabels]);

  const removePrimaryLabel = useCallback((item: string) => {
    const newList = primaryLabels.filter(i => i !== item);
    setPrimaryLabels(newList);
    savePrimaryLabels(newList);
  }, [primaryLabels, savePrimaryLabels]);

  const addKeyword = useCallback(() => {
    if (!newKeyword.trim() || keywords.includes(newKeyword.trim())) return;
    const newList = [...keywords, newKeyword.trim()];
    setKeywords(newList);
    setNewKeyword('');
    saveKeywords(newList);
  }, [newKeyword, keywords, saveKeywords]);

  const removeKeyword = useCallback((item: string) => {
    const newList = keywords.filter(i => i !== item);
    setKeywords(newList);
    saveKeywords(newList);
  }, [keywords, saveKeywords]);

  const addIgnoreKeyword = useCallback(() => {
    if (!newIgnoreKeyword.trim() || ignoreKeywords.includes(newIgnoreKeyword.trim())) return;
    const newList = [...ignoreKeywords, newIgnoreKeyword.trim()];
    setIgnoreKeywords(newList);
    setNewIgnoreKeyword('');
    saveIgnoreKeywords(newList);
  }, [newIgnoreKeyword, ignoreKeywords, saveIgnoreKeywords]);

  const removeIgnoreKeyword = useCallback((item: string) => {
    const newList = ignoreKeywords.filter(i => i !== item);
    setIgnoreKeywords(newList);
    saveIgnoreKeywords(newList);
  }, [ignoreKeywords, saveIgnoreKeywords]);

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
