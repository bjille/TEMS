require('dotenv').config();
const bcrypt = require('bcryptjs');
const { connectDb } = require('../config/db');
const env = require('../config/env');
const User = require('../models/User');

async function seed() {
  await connectDb();

  const existing = await User.findOne({ email: env.seedAdmin.email });
  if (existing) {
    console.log(`Seed admin ${env.seedAdmin.email} already exists, skipping.`);
    process.exit(0);
  }

  const passwordHash = await bcrypt.hash(env.seedAdmin.password, 12);
  await User.create({
    email: env.seedAdmin.email,
    passwordHash,
    name: 'Superadmin',
    role: 'superadmin',
  });

  console.log(`Created superadmin user: ${env.seedAdmin.email}`);
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed', err);
  process.exit(1);
});
