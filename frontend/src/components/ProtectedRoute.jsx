import { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Navigate, Outlet } from 'react-router-dom';
import { fetchMe, selectAuth } from '../features/auth/authSlice';
import { getAccessToken } from '../services/api';

export default function ProtectedRoute({ requireSuperadmin = false }) {
  const dispatch = useDispatch();
  const { user, status } = useSelector(selectAuth);

  useEffect(() => {
    if (!user && status === 'idle' && getAccessToken()) {
      dispatch(fetchMe());
    }
  }, [user, status, dispatch]);

  if (!getAccessToken()) return <Navigate to="/welkom" replace />;
  if (!user && (status === 'idle' || status === 'loading')) {
    return <div className="page-loading">Laden...</div>;
  }
  if (!user) return <Navigate to="/welkom" replace />;
  if (requireSuperadmin && user.role !== 'superadmin') return <Navigate to="/" replace />;

  return <Outlet />;
}
