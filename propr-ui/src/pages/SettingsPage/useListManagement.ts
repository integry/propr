import { useState, useCallback } from 'react';
type SaveList = (items: string[]) => void;

/**
 * One tag list: the saved items plus the text still being typed. `add` takes
 * every entry parsed from the field at once, so a pasted list becomes one
 * updated list and one save. `minItems` keeps a required list from emptying.
 */
function useTagList(save: SaveList, minItems = 0) {
  const [items, setItems] = useState<string[]>([]);
  const [draft, setDraft] = useState('');

  const add = useCallback((values: string[]) => {
    const newItems = values.map(value => value.trim()).filter((value, index, all) =>
      value && !items.includes(value) && all.indexOf(value) === index);
    if (newItems.length === 0) return;
    const newList = [...items, ...newItems];
    setItems(newList);
    save(newList);
  }, [items, save]);

  const remove = useCallback((item: string) => {
    const newList = items.filter(i => i !== item);
    if (newList.length < minItems) return;
    setItems(newList);
    save(newList);
  }, [items, minItems, save]);

  return { items, setItems, draft, setDraft, add, remove };
}

export function useListManagement(
  saveWhitelist: SaveList,
  savePrimaryLabels: SaveList,
  saveKeywords: SaveList,
  saveIgnoreKeywords: SaveList
) {
  const whitelist = useTagList(saveWhitelist);
  // The server rejects an empty primary label list, so the last label stays.
  const primaryLabels = useTagList(savePrimaryLabels, 1);
  const keywords = useTagList(saveKeywords);
  const ignoreKeywords = useTagList(saveIgnoreKeywords);

  return {
    whitelist: whitelist.items, setWhitelist: whitelist.setItems,
    newWhitelistItem: whitelist.draft, setNewWhitelistItem: whitelist.setDraft,
    primaryLabels: primaryLabels.items, setPrimaryLabels: primaryLabels.setItems,
    newPrimaryLabel: primaryLabels.draft, setNewPrimaryLabel: primaryLabels.setDraft,
    keywords: keywords.items, setKeywords: keywords.setItems,
    newKeyword: keywords.draft, setNewKeyword: keywords.setDraft,
    ignoreKeywords: ignoreKeywords.items, setIgnoreKeywords: ignoreKeywords.setItems,
    newIgnoreKeyword: ignoreKeywords.draft, setNewIgnoreKeyword: ignoreKeywords.setDraft,
    addWhitelistItems: whitelist.add, removeWhitelistItem: whitelist.remove,
    addPrimaryLabels: primaryLabels.add, removePrimaryLabel: primaryLabels.remove,
    addKeywords: keywords.add, removeKeyword: keywords.remove,
    addIgnoreKeywords: ignoreKeywords.add, removeIgnoreKeyword: ignoreKeywords.remove,
  };
}
