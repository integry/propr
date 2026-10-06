import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createSchedule, deleteSchedule, listSchedules, runScheduleNow, updateSchedule,
  type ScheduleInput, type TaskSchedule, type TaskScheduleRun, type UnattendedAdmission,
} from '../../../api/scheduleApi';
import { errorMessage } from './scheduleFormat';

export interface SchedulesState {
  schedules: TaskSchedule[];
  admission: UnattendedAdmission | null;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  create(input: ScheduleInput): Promise<TaskSchedule>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  remove(id: string): Promise<void>;
  runNow(id: string): Promise<TaskScheduleRun>;
}

/** Loads schedules and the unattended-work admission state, and applies changes to the list. */
export function useSchedules(): SchedulesState {
  const [schedules, setSchedules] = useState<TaskSchedule[]>([]);
  const [admission, setAdmission] = useState<UnattendedAdmission | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const result = await listSchedules();
      if (!mounted.current) return;
      setSchedules(result.schedules);
      setAdmission(result.admission);
      setError(null);
    } catch (err) {
      if (mounted.current) setError(errorMessage(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  const replace = useCallback((schedule: TaskSchedule) => {
    setSchedules(current => current.map(item => item.id === schedule.id ? schedule : item));
  }, []);

  const create = useCallback(async (input: ScheduleInput) => {
    const { schedule } = await createSchedule(input);
    setSchedules(current => [...current, schedule]);
    return schedule;
  }, []);

  const setEnabled = useCallback(async (id: string, enabled: boolean) => {
    const { schedule } = await updateSchedule(id, { enabled });
    replace(schedule);
  }, [replace]);

  const remove = useCallback(async (id: string) => {
    await deleteSchedule(id);
    setSchedules(current => current.filter(item => item.id !== id));
  }, []);

  const runNow = useCallback(async (id: string) => {
    const { schedule, run } = await runScheduleNow(id);
    replace(schedule);
    return run;
  }, [replace]);

  return { schedules, admission, loading, error, refresh, create, setEnabled, remove, runNow };
}
