import { useState, useEffect, useRef } from 'react';
import { 
  fetchLogFiles as apiFetchLogFiles, 
  fetchLogFile as apiFetchLogFile 
} from '../../api/proprApi';
import { LogFilesData, SelectedLogFileData } from './types';
import { isLogFilesData } from './apiDataGuards';
import { findLogMatches, logSearchText } from './logSearch';

export const useLogFilesData = () => {
  const [logFiles, setLogFiles] = useState<LogFilesData | null>(null);
  const [selectedLogFile, setSelectedLogFile] = useState<SelectedLogFileData | null>(null);
  const [loadingLogFile, setLoadingLogFile] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchMatches, setSearchMatches] = useState<RegExpMatchArray[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState<number>(0);
  const logContentRef = useRef<HTMLPreElement | null>(null);
  // Only the latest list request may open the viewer; closing it abandons any request still pending.
  const viewerRequestRef = useRef(0);

  useEffect(() => {
    if (selectedLogFile && searchQuery) {
      setSearchMatches(findLogMatches(logSearchText(selectedLogFile.content, selectedLogFile.isJson), searchQuery));
    } else {
      setSearchMatches([]);
    }
    setCurrentMatchIndex(0);
  }, [searchQuery, selectedLogFile]);

  useEffect(() => {
    if (searchMatches.length > 0 && logContentRef.current) {
      const element = logContentRef.current.querySelector(`[data-match-index="${currentMatchIndex}"]`);
      element?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }
  }, [currentMatchIndex, searchMatches]);

  const fetchLogFilesData = async (logsPath: string) => {
    const request = ++viewerRequestRef.current;
    const isCurrent = () => request === viewerRequestRef.current;
    try {
      setLoadingLogFile(true);
      setSelectedLogFile(null);
      const logsData = await apiFetchLogFiles(logsPath);
      if (!isCurrent()) return;
      if (!isLogFilesData(logsData)) throw new Error('Invalid log files response');
      
      if (logsData.files) {
        const transformedData = {
          sessionId: logsData.sessionId,
          logFiles: Object.entries(logsData.files).map(([type, path]) => ({
            name: path.split('/').pop() || '',
            path: `/api/execution/${logsData.sessionId}/logs/${type}`,
            type: type
          }))
        };
        setLogFiles(transformedData);
      } else {
        setLogFiles(logsData);
      }
    } catch (err) {
      if (!isCurrent()) return;
      console.error('Error fetching log files:', err);
      setLogFiles({ error: 'Failed to load log files.' });
    } finally {
      if (isCurrent()) setLoadingLogFile(false);
    }
  };

  const fetchLogFile = async (fileName: string) => {
    if (!logFiles?.logFiles) return;
    const request = viewerRequestRef.current;
    const isCurrent = () => request === viewerRequestRef.current;

    try {
      setLoadingLogFile(true);
      const fileInfo = logFiles.logFiles.find(f => f.name === fileName);
      if (!fileInfo) {
        throw new Error('Log file not found');
      }

      const content = await apiFetchLogFile(fileInfo.path);
      if (!isCurrent()) return;
      const isJson = fileName.endsWith('.json');

      setSelectedLogFile({
        name: fileName,
        content: isJson ? JSON.parse(content) : content,
        isJson: isJson
      });
      setSearchQuery('');
    } catch (err) {
      if (!isCurrent()) return;
      console.error('Error fetching log file:', err);
      setSelectedLogFile({
        name: fileName,
        content: 'Failed to load log file content.',
        isJson: false
      });
    } finally {
      if (isCurrent()) setLoadingLogFile(false);
    }
  };

  const closeLogFiles = () => {
    viewerRequestRef.current++;
    setLoadingLogFile(false);
    setLogFiles(null);
    setSelectedLogFile(null);
    setSearchQuery('');
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
