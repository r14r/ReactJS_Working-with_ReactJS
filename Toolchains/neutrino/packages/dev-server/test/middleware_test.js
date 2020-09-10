import test from 'ava';
import Neutrino from '../../neutrino/Neutrino';

const mw = (...args) => require('..')(...args);
const options = { host: '192.168.1.10', port: 3000, https: true };

test('loads middleware', (t) => {
  t.notThrows(() => require('..'));
});

test('uses middleware', (t) => {
  t.notThrows(() => new Neutrino().use(mw()));
});

test('uses with options', (t) => {
  t.notThrows(() => new Neutrino().use(mw(options)));
});

test('instantiates', (t) => {
  const api = new Neutrino();

  api.use(mw());

  t.notThrows(() => api.config.toConfig());
});

test('instantiates with options', (t) => {
  const api = new Neutrino();

  api.use(mw(options));

  t.notThrows(() => api.config.toConfig());
});
