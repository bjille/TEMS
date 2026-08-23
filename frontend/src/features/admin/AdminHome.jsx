import { NavLink, Outlet } from 'react-router-dom';

export default function AdminHome() {
  return (
    <div>
      <div className="section-header">
        <h1>Admin</h1>
        <nav style={{ display: 'flex', gap: 12 }}>
          <NavLink to="woningen" className="btn">
            Woningen
          </NavLink>
          <NavLink to="parameters" className="btn">
            Parameters
          </NavLink>
          <NavLink to="charts" className="btn">
            Grafieken
          </NavLink>
          <NavLink to="users" className="btn">
            Gebruikers
          </NavLink>
          <NavLink to="global-automations" className="btn">
            Globale automatiseringen
          </NavLink>
          <NavLink to="global-parameters" className="btn">
            Globale parameters
          </NavLink>
        </nav>
      </div>
      <Outlet />
    </div>
  );
}
