import Home from './pages/home.jsx';

import Login from './pages/login.jsx';

import Search from './pages/search.jsx';
import RecentBans from './pages/recent-bans.jsx';
import MostHarmfulPlayers from './pages/most-harmful-players.jsx';
import MostHarmfulPlayersThisMonth from './pages/most-harmful-players-this-month.jsx';

import EditExportBanList from './pages/create-export-ban-list.jsx';
import ExportBanLists from './pages/export-ban-lists.jsx';

import BecomeAPartnerOrganisation from './pages/become-a-partner-organisation.jsx';

import FAQ from './pages/faq.jsx';
import PartnerOrganisationList from './pages/partner-organisation-list.jsx';
import Banned from './pages/banned.jsx';

// import Auth from '../utils/auth.js';

const routes = [
  {
    path: '/',
    exact: true,
    login: false,
    component: Home
  },

  {
    path: '/login',
    exact: true,
    login: false,
    component: Login
  },

  {
    path: '/search/:search',
    exact: false,
    login: false,
    component: Search
  },
  {
    path: '/search',
    exact: true,
    login: false,
    component: Search
  },
  {
    path: '/recent-bans',
    exact: true,
    login: false,
    component: RecentBans
  },
  {
    path: '/most-harmful-players',
    exact: true,
    login: false,
    component: MostHarmfulPlayers
  },
  {
    path: '/most-harmful-players-this-month',
    exact: true,
    login: false,
    component: MostHarmfulPlayersThisMonth
  },

  {
    path: '/export-ban-lists/:id',
    exact: false,
    login: true,
    component: EditExportBanList
  },
  {
    path: '/export-ban-lists',
    exact: true,
    login: true,
    component: ExportBanLists
  },

  {
    path: '/become-a-partner-organisation',
    exact: true,
    login: false,
    component: BecomeAPartnerOrganisation
  },

  {
    path: '/faq',
    exact: false,
    login: false,
    component: FAQ
  },

  {
    path: '/partner-organisation-list',
    exact: true,
    login: false,
    component: PartnerOrganisationList
  },

  {
    path: '/banned/:steamUser',
    exact: false,
    login: false,
    component: Banned
  },

  {
    path: '/banned/',
    exact: true,
    login: false,
    component: Banned
  }
];

export default routes;
