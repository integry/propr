import React, { useEffect, useState } from 'react'
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './components/Dashboard'
import RepositoriesPage from './pages/RepositoriesPage'
import TasksPage from './pages/TasksPage'
// TaskPlannerPage removed - all plan routes now use PlanStudioPage
import PlanStudioPage from './pages/PlanStudioPage'
import PlansPage from './pages/PlansPage'
import AiAgentsPage from './pages/AiAgentsPage'
import SettingsPage from './pages/SettingsPage'
import SummaryBrowserPage from './pages/SummaryBrowserPage'
import LlmLogsPage from './pages/LlmLogsPage'
import LoginPage from './pages/LoginPage'
import RevertPage from './pages/RevertPage'
import { ToastProvider } from './components/ui/Toast'
import { SocketProvider } from './contexts/SocketProvider'
import { DemoModeProvider } from './contexts/DemoModeContext'
import DemoModeBanner from './components/DemoModeBanner'
import './App.css'
import { getCurrentUser } from './api/proprApi'

const App: React.FC = () => {
  // Auth check state - start loading unless already on login page
  const [isLoading, setIsLoading] = useState(window.location.pathname !== '/login');

  // Perform initial auth check
  useEffect(() => {
    const checkSession = async () => {
      // Don't check if we are already on login page
      if (window.location.pathname === '/login') {
        setIsLoading(false);
        return;
      }

      try {
        await getCurrentUser();
        // Session is valid
        setIsLoading(false);
      } catch (error) {
        // If error is NOT 'Authentication required', we let the app render (to show errors).
        // If it IS 'Authentication required', handleApiResponse handles the redirect,
        // so we keep isLoading=true to prevent UI flash.
        if (error instanceof Error && error.message !== 'Authentication required') {
          setIsLoading(false);
        }
      }
    };

    checkSession();
  }, []);


  // Render spinner while checking auth
  if (isLoading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-gray-50">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-200 border-t-blue-600" />
      </div>
    );
  }

  return (
    <DemoModeProvider>
      <SocketProvider>
        <ToastProvider>
          <div className="flex h-screen flex-col">
            <DemoModeBanner />
            <div className="min-h-0 flex-1">
              <Router>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/revert" element={<RevertPage />} />
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
                  path="/studio/new"
                  element={
                    <Layout>
                      <PlanStudioPage isNew />
                    </Layout>
                  }
                />
                <Route
                  path="/studio/:draftId"
                  element={
                    <Layout>
                      <PlanStudioPage />
                    </Layout>
                  }
                />
                <Route
                  path="/plans"
                  element={
                    <Layout>
                      <PlansPage />
                    </Layout>
                  }
                />
                <Route
                  path="/ai-agents"
                  element={
                    <Layout>
                      <AiAgentsPage />
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
                <Route
                  path="/summaries/:owner/:repo"
                  element={
                    <Layout>
                      <SummaryBrowserPage />
                    </Layout>
                  }
                />
                <Route
                  path="/llm-logs"
                  element={
                    <Layout>
                      <LlmLogsPage />
                    </Layout>
                  }
                />
              </Routes>
              </Router>
            </div>
          </div>
        </ToastProvider>
      </SocketProvider>
    </DemoModeProvider>
  )
}

export default App
