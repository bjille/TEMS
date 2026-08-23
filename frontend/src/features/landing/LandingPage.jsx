import { Link } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { selectAuth } from '../auth/authSlice';
import { CATEGORICAL } from '../../palette';
import './LandingPage.css';

const FEATURES = [
  {
    title: 'Live inzicht',
    body: 'Bekijk in realtime je batterijstatus, zonneproductie, elektriciteitsprijzen en verbruik — rechtstreeks uit je eigen installatie, zonder zelf een dashboard te bouwen.',
    color: CATEGORICAL.blue,
  },
  {
    title: 'Zelf bedienen',
    body: 'Schakel stuurbare stopcontacten of je batterij op afstand, van op je gsm of pc, zonder in te loggen op je installatie zelf.',
    color: CATEGORICAL.violet,
  },
  {
    title: 'Energieprofiel op maat',
    body: 'We bepalen het energieprofiel van je woning en stellen op basis daarvan automatisch de juiste sturingen in — zodat je bespaart zonder dat je er zelf iets voor moet instellen.',
    color: CATEGORICAL.orange,
  },
  {
    title: 'Slim laden, lagere kosten',
    body: 'Je batterij wordt geladen op het optimale moment, op basis van je eigen zonneproductie en het variabele energietarief — zo gebruik je zoveel mogelijk je eigen, goedkope energie.',
    color: CATEGORICAL.green,
  },
  {
    title: 'Piekverbruik onder controle',
    body: 'Apparaten worden gespreid over de dag in- en uitgeschakeld, zodat je piekverbruik onder je capaciteitstarief-grens blijft — en je niet meer betaalt dan nodig.',
    color: CATEGORICAL.magenta,
  },
  {
    title: 'Meerdere woningen, één overzicht',
    body: 'Beheer al je installaties centraal: favoriete parameters per woning, gebruikersrechten en toegang, allemaal op één plek.',
    color: CATEGORICAL.aqua,
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
          TEMS verbindt met je eigen energie-installatie en toont batterij, zonnepanelen,
          elektriciteitsprijzen en verbruik in een helder dashboard — waar je ook bent, en helpt je
          besparen op je energiefactuur.
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
            <span className="landing-feature-icon" style={{ background: f.color }} />
            <h3>{f.title}</h3>
            <p className="muted">{f.body}</p>
          </div>
        ))}
      </section>

      <section className="landing-how">
        <h2>Hoe werkt het?</h2>
        <ol className="landing-steps">
          <li>Een beheerder koppelt je woning aan je energie-installatie.</li>
          <li>Op basis van je verbruik, productie en tarief wordt een energieprofiel voor je woning bepaald.</li>
          <li>De juiste sturingen worden automatisch ingesteld: je batterij laadt op het beste moment en je apparaten worden gespreid, zodat je piekverbruik onder je capaciteitstarief-grens blijft.</li>
          <li>Je logt in en volgt je energieverbruik en besparing live op, waar en wanneer je wil.</li>
        </ol>
      </section>

      <footer className="landing-footer muted">TEMS — Energiemanagement Platform</footer>
    </div>
  );
}
