import React, { useState } from 'react';
import { DropdownItem, DropdownMenu, DropdownToggle, UncontrolledDropdown } from 'reactstrap';

import { getColorMode, setColorMode } from '../../utils/color-mode.js';

const MODES = [
  { mode: 'light', label: 'Light', icon: 'fa-sun' },
  { mode: 'dark', label: 'Dark', icon: 'fa-moon' },
  { mode: 'auto', label: 'System', icon: 'fa-adjust' }
];

// A navbar menu for choosing light mode, dark mode, or the device's setting.
export default function () {
  const [colorMode, updateColorMode] = useState(getColorMode);
  const current = MODES.find(({ mode }) => mode === colorMode);

  return (
    <UncontrolledDropdown nav>
      <DropdownToggle nav className="nav-link-icon" aria-label="Theme">
        <i className={`fa ${current.icon}`} />
        <span className="nav-link-inner--text d-lg-none ms-2">Theme</span>
      </DropdownToggle>
      <DropdownMenu>
        {MODES.map(({ mode, label, icon }) => (
          <DropdownItem
            key={mode}
            active={mode === colorMode}
            onClick={() => {
              setColorMode(mode);
              updateColorMode(mode);
            }}
          >
            <i className={`fa ${icon} me-2`} />
            {label}
          </DropdownItem>
        ))}
      </DropdownMenu>
    </UncontrolledDropdown>
  );
}
