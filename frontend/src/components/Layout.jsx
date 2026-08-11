import { Link, NavLink, Outlet } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { logout, selectAuth } from '../features/auth/authSlice';
import WoningSelector from '../features/woningen/WoningSelector';
import './Layout.css';

export default function Layout() {
  const dispatch = useDispatch();
  const { user } = useSelector(selectAuth);

  return (
    <div className="layout">
      <header className="layout-header">
        <Link to="/welkom" className="layout-brand">
          TEMS
        </Link>
        <nav className="layout-nav">
          <NavLink to="/" end>
            Dashboard
          </NavLink>
          <NavLink to="/control">Besturing</NavLink>
          <NavLink to="/automations">Automatiseringen</NavLink>
          {user?.role === 'superadmin' && <NavLink to="/admin">Admin</NavLink>}
        </nav>
        <div className="layout-actions">
          <WoningSelector />
          <span className="layout-user">{user?.name}</span>
          <button className="btn btn-ghost" onClick={() => dispatch(logout())}>
            Uitloggen
          </button>
        </div>
      </header>
      <main className="layout-main">
        <Outlet />
      </main>
    </div>
  );
}
