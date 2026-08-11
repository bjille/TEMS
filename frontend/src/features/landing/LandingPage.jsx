import { Link } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { selectAuth } from '../auth/authSlice';
import './LandingPage.css';

const FEATURES = [
  {
    title: 'Live inzicht',
    body: 'Bekijk in realtime je batterijstatus, zonneproductie, elektriciteitsprijzen en verbruik — rechtstreeks uit je eigen Home Assistant, zonder zelf een dashboard te bouwen.',
  },
  {
    title: 'Zelf bedienen',
    body: 'Schakel stuurbare stopcontacten of je batterij op afstand, van op je gsm of pc, zonder in te loggen op Home Assistant zelf.',
  },
  {
    title: 'Automatiseringen',
    body: 'Stel regels in die zelf reageren op metingen of tijdstippen — bijvoorbeeld laden wanneer de stroom het goedkoopst is.',
  },
  {
    title: 'Meerdere woningen, één overzicht',
    body: 'Beheer al je installaties centraal: favoriete parameters per woning, gebruikersrechten en toegang, allemaal op één plek.',
  },
];

export default function LandingPage() {
  const { user } = useSelector(selectAuth);

  return (
    <div className="landing-page">
      <header className="landing-header">
        <div className="landing-brand">TEMS</div>
        {user ? (
          <Link className="btn btn-primary" to="/">
            Naar dashboard
          </Link>
        ) : (
          <Link className="btn btn-primary" to="/login">
            Inloggen
          </Link>
        )}
      </header>

      <section className="landing-hero">
        <h1>Eén overzicht voor je energie thuis</h1>
        <p className="landing-lead">
          TEMS verbindt met je eigen Home Assistant-installatie en toont batterij, zonnepanelen,
          elektriciteitsprijzen en verbruik in een helder dashboard — waar je ook bent, zonder zelf
          iets te moeten programmeren.
        </p>
        {user ? (
          <Link className="btn btn-primary" to="/">
            Ga naar je dashboard →
          </Link>
        ) : (
          <Link className="btn btn-primary" to="/login">
            Inloggen om te starten →
          </Link>
        )}
      </section>

      <section className="landing-features grid">
        {FEATURES.map((f) => (
          <div key={f.title} className="card landing-feature">
            <h3>{f.title}</h3>
            <p className="muted">{f.body}</p>
          </div>
        ))}
      </section>

      <section className="landing-how">
        <h2>Hoe werkt het?</h2>
        <ol className="landing-steps">
          <li>Een beheerder koppelt je woning aan je Home Assistant-installatie.</li>
          <li>Je krijgt een account en de belangrijkste gegevens worden als favoriet gemarkeerd.</li>
          <li>Je logt in en volgt je energieverbruik live op, waar en wanneer je wil.</li>
        </ol>
      </section>

      <footer className="landing-footer muted">TEMS — Home Assistant Energiemanagement Platform</footer>
    </div>
  );
}
