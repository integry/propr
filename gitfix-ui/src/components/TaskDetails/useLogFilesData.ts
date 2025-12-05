import { useState, useEffect, useRef } from 'react';
import { 
  fetchLogFiles as apiFetchLogFiles, 
  fetchLogFile as apiFetchLogFile 
} from '../../api/gitfixApi';
import { LogFilesData, SelectedLogFileData } from './types';

export const useLogFilesData = () => {
  const [logFiles, setLogFiles] = useState<LogFilesData | null>(null);
  const [selectedLogFile, setSelectedLogFile] = useState<SelectedLogFileData | null>(null);
  const [loadingLogFile, setLoadingLogFile] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchMatches, setSearchMatches] = useState<RegExpMatchArray[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState<number>(0);
  const logContentRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (selectedLogFile && searchQuery) {
      const content = selectedLogFile.isJson
        ? JSON.stringify(selectedLogFile.content, null, 2)
        : selectedLogFile.content;
      const regex = new RegExp(searchQuery, 'gi');
      const matches = [...(content as string).matchAll(regex)];
      setSearchMatches(matches);
      setCurrentMatchIndex(0);
    } else {
      setSearchMatches([]);
    }
  }, [searchQuery, selectedLogFile]);

  useEffect(() => {
    if (searchMatches.length > 0 && logContentRef.current) {
      const highlightId = `match-${currentMatchIndex}`;
      const element = document.getElementById(highlightId);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [currentMatchIndex, searchMatches]);

  const fetchLogFilesData = async (logsPath: string) => {
    try {
      setLoadingLogFile(true);
      setSelectedLogFile(null);
      const logsData = await apiFetchLogFiles(logsPath);
      
      if (logsData.files) {
        const transformedData = {
          sessionId: logsData.sessionId,
          logFiles: Object.entries(logsData.files).map(([type, path]) => ({
            name: (path as string).split('/').pop() || '',
            path: `/api/execution/${logsData.sessionId}/logs/${type}`,
            size: 0,
            type: type
          }))
        };
        setLogFiles(transformedData);
      } else {
        setLogFiles(logsData);
      }
    } catch (err) {
      console.error('Error fetching log files:', err);
      setLogFiles({ error: 'Failed to load log files.' });
    } finally {
      setLoadingLogFile(false);
    }
  };

  const fetchLogFile = async (fileName: string) => {
    if (!logFiles?.logFiles) return;

    try {
      setLoadingLogFile(true);
      const fileInfo = logFiles.logFiles.find(f => f.name === fileName);
      if (!fileInfo) {
        throw new Error('Log file not found');
      }

      const content = await apiFetchLogFile(fileInfo.path);
      const isJson = fileName.endsWith('.json');

      setSelectedLogFile({
        name: fileName,
        content: isJson ? JSON.parse(content) : content,
        isJson: isJson
      });
      setSearchQuery('');
    } catch (err) {
      console.error('Error fetching log file:', err);
      setSelectedLogFile({
        name: fileName,
        content: 'Failed to load log file content.',
        isJson: false
      });
    } finally {
      setLoadingLogFile(false);
    }
  };

  const closeLogFiles = () => {
    setLogFiles(null);
    setSelectedLogFile(null);
  };

  return {
    logFiles,
    selectedLogFile,
    loadingLogFile,
    searchQuery,
    setSearchQuery,
    searchMatches,
    currentMatchIndex,
    setCurrentMatchIndex,
    logContentRef,
    fetchLogFilesData,
    fetchLogFile,
    closeLogFiles
  };
};
