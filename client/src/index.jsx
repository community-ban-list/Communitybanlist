import React from 'react';
import { createRoot } from 'react-dom/client';

import '@fortawesome/fontawesome-free/css/all.min.css';

import './assets/scss/core.scss';

import App from './app';

createRoot(document.getElementById('root')).render(<App />);
