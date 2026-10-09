import { jwtDecode } from 'jwt-decode';

import httpClient from './http-client';

import { LOCALSTORAGE_VERSION } from 'scbl-lib/config';

import { COLOR_MODE_KEY } from './color-mode.js';

class Auth {
  constructor() {
    this.flush();
  }

  flush() {
    this.isLoggedIn = false;
    this.jwtToken = null;
    this.saveToken = null;
    this.claim = null;
  }

  logout() {
    this.flush();
    localStorage.removeItem('JWT');
  }

  storeToken() {
    localStorage.setItem('JWT', this.jwtToken);
  }

  restoreAuth() {
    if (localStorage.getItem('LOCALSTORAGE_VERSION') !== LOCALSTORAGE_VERSION) {
      // Keep the colour mode, which does not depend on the stored data's version.
      const colorMode = localStorage.getItem(COLOR_MODE_KEY);
      localStorage.clear();
      if (colorMode) localStorage.setItem(COLOR_MODE_KEY, colorMode);
      localStorage.setItem('LOCALSTORAGE_VERSION', LOCALSTORAGE_VERSION);
    }

    if (localStorage.getItem('JWT') === null) return false;
    const token = localStorage.getItem('JWT');

    this.isLoggedIn = true;
    this.jwtToken = token;
    this.saveToken = true;
    this.claim = jwtDecode(token).user;
    return true;
  }

  async attemptAuth(queryString) {
    this.flush();

    console.log('attempt auth');

    const response = await httpClient.get('/auth/steam/return' + queryString);

    console.log(response);

    this.isLoggedIn = true;
    this.jwtToken = response.data.token;
    this.claim = jwtDecode(response.data.token).user;
  }
}

export default new Auth();
