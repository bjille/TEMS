import { Routes, Route, Navigate } from 'react-router-dom';
import LandingPage from './features/landing/LandingPage';
import LoginPage from './features/auth/LoginPage';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import Dashboard from './features/parameters/Dashboard';
import HistoryPage from './features/history/HistoryPage';
import ControlPage from './features/control/ControlPage';
import AutomationsPage from './features/automations/AutomationsPage';
import AdminHome from './features/admin/AdminHome';
import AdminWoningen from './features/admin/AdminWoningen';
import AdminParameters from './features/admin/AdminParameters';
import AdminUsers from './features/admin/AdminUsers';
import AdminGlobalAutomations from './features/admin/AdminGlobalAutomations';
import AdminGlobalParameters from './features/admin/AdminGlobalParameters';

export default function App() {
  return (
    <Routes>
      <Route path="/welkom" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/woningen/:woningId/parameters/:parameterId/history" element={<HistoryPage />} />
          <Route path="/control" element={<ControlPage />} />
          <Route path="/automations" element={<AutomationsPage />} />

          <Route element={<ProtectedRoute requireSuperadmin />}>
            <Route path="/admin" element={<AdminHome />}>
              <Route index element={<Navigate to="woningen" replace />} />
              <Route path="woningen" element={<AdminWoningen />} />
              <Route path="parameters" element={<AdminParameters />} />
              <Route path="users" element={<AdminUsers />} />
              <Route path="global-automations" element={<AdminGlobalAutomations />} />
              <Route path="global-parameters" element={<AdminGlobalParameters />} />
            </Route>
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
