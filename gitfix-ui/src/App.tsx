import React, { useEffect } from 'react'
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './components/Dashboard'
import RepositoriesPage from './pages/RepositoriesPage'
import TasksPage from './pages/TasksPage'
import TaskPlannerPage from './pages/TaskPlannerPage'
import AiToolsPage from './pages/AiToolsPage'
import SettingsPage from './pages/SettingsPage'
import LoginPage from './pages/LoginPage'
import './App.css'
import { getSystemStatus } from './api/gitfixApi'

const App: React.FC = () => {
  useEffect(() => {
    const favicon = document.getElementById('favicon') as HTMLLinkElement | null;
    const defaultFavicon = '/logo.png';
    const loadingFavicon = '/logo-loading.png';

    const updateFavicon = async () => {
      if (window.location.pathname === '/login') {
        if (favicon) {
          favicon.href = defaultFavicon;
        }
        return;
      }
      try {
        const status = await getSystemStatus();
        const isTaskRunning = status.workers.some((w: { status: string }) => w.status === 'active');
        if (favicon) {
          favicon.href = isTaskRunning ? loadingFavicon : defaultFavicon;
        }
      } catch (error) {
        console.error('Failed to update favicon:', error);
        if (favicon) {
          favicon.href = defaultFavicon;
        }
      }
    };

    updateFavicon();
    const interval = setInterval(updateFavicon, 5000);

    return () => clearInterval(interval);
  }, []);

  return (
    <Router>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <Layout>
              <Dashboard />
            </Layout>
          }
        />
        <Route
          path="/repositories"
          element={
            <Layout>
              <RepositoriesPage />
            </Layout>
          }
        />
        <Route
          path="/tasks"
          element={
            <Layout>
              <TasksPage />
            </Layout>
          }
        />
        <Route
          path="/tasks/:taskId"
          element={
            <Layout>
              <TasksPage />
            </Layout>
          }
        />
        <Route
          path="/tasks/plan/:draftId"
          element={
            <Layout>
              <TaskPlannerPage />
            </Layout>
          }
        />
        <Route
          path="/ai-tools"
          element={
            <Layout>
              <AiToolsPage />
            </Layout>
          }
        />
        <Route
          path="/settings"
          element={
            <Layout>
              <SettingsPage />
            </Layout>
          }
        />
      </Routes>
    </Router>
  )
}

export default App

