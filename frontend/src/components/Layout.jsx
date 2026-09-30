import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { logout, selectAuth } from '../features/auth/authSlice';
import WoningSelector from '../features/woningen/WoningSelector';
import './Layout.css';

export default function Layout() {
  const dispatch = useDispatch();
  const { user } = useSelector(selectAuth);
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  // On mobile the menu is an overlay panel: navigating away should close it
  // rather than leave it covering the page that was just opened.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className="layout">
      <header className="layout-header">
        <Link to="/welkom" className="layout-brand">
          TEMS
        </Link>
        <button
          type="button"
          className={`layout-menu-toggle${menuOpen ? ' open' : ''}`}
          aria-label={menuOpen ? 'Menu sluiten' : 'Menu openen'}
          aria-expanded={menuOpen}
          aria-controls="layout-menu"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span />
          <span />
          <span />
        </button>
        <div id="layout-menu" className={`layout-menu${menuOpen ? ' open' : ''}`}>
          <nav className="layout-nav">
            <NavLink to="/" end>
              Dashboard
            </NavLink>
            <NavLink to="/control">Besturing</NavLink>
            <NavLink to="/automations">Automatiseringen</NavLink>
            <NavLink to="/smart-charge">Slim laden</NavLink>
            {user?.role === 'superadmin' && <NavLink to="/admin">Admin</NavLink>}
          </nav>
          <div className="layout-actions">
            <WoningSelector />
            <span className="layout-user">{user?.name}</span>
            <button className="btn btn-ghost" onClick={() => dispatch(logout())}>
              Uitloggen
            </button>
          </div>
        </div>
      </header>
      {menuOpen && <div className="layout-menu-backdrop" onClick={() => setMenuOpen(false)} />}
      <main className="layout-main">
        <Outlet />
      </main>
    </div>
  );
}
