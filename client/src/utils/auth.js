import { jwtDecode } from 'jwt-decode';

import httpClient from './http-client';
import readSignInToken from './sign-in-token.js';

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

    const token = localStorage.getItem('JWT');
    if (token === null) return false;

    // Forget a token that cannot be read or has expired, so the user is shown as signed out
    // instead of looking signed in while the web server answers every request as signed out.
    const signIn = readSignInToken(token);
    if (!signIn || signIn.expires <= Date.now()) {
      localStorage.removeItem('JWT');
      return false;
    }

    this.isLoggedIn = true;
    this.jwtToken = token;
    this.saveToken = true;
    this.claim = signIn.user;
    return true;
  }

  async attemptAuth(queryString) {
    this.flush();

    const response = await httpClient.get('/auth/steam/return' + queryString);

    this.isLoggedIn = true;
    this.jwtToken = response.data.token;
    this.claim = jwtDecode(response.data.token).user;
  }

  // The web server answered a request as signed out, as it no longer accepts the sign-in token,
  // e.g. as it has expired. Forget the token, and return whether the user was signed in with it.
  // Another tab may have stored a newer token since, so the stored token is only removed if it is
  // this one.
  forgetRejectedToken() {
    if (!this.isLoggedIn) return false;
    if (localStorage.getItem('JWT') === this.jwtToken) localStorage.removeItem('JWT');
    this.flush();
    return true;
  }
}

export default new Auth();
