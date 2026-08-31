import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import GoalsPage from './GoalsPage';

const Location = () => {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
};

const HistoryControls = () => {
  const navigate = useNavigate();
  return <><button onClick={() => navigate(-1)}>Browser back</button><button onClick={() => navigate(1)}>Browser forward</button></>;
};

export default function GoalsPageTestView({ entries, initialIndex }: { entries: string[]; initialIndex: number }) {
  return <MemoryRouter initialEntries={entries} initialIndex={initialIndex}>
    <Routes>
      <Route path="/goals" element={<GoalsPage />} />
      <Route path="/goals/new" element={<div>New goal route</div>} />
      <Route path="/goals/:goalId" element={<div>Goal detail route</div>} />
    </Routes>
    <Location />
    <HistoryControls />
  </MemoryRouter>;
}
