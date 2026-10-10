import React from 'react';
import { Link } from 'react-router';

import Headroom from 'headroom.js';

import {
  Button,
  UncontrolledCollapse,
  DropdownMenu,
  DropdownToggle,
  DropdownItem,
  UncontrolledDropdown,
  NavbarBrand,
  Navbar,
  Nav,
  NavItem,
  NavLink,
  Container,
  Row,
  Col,
  UncontrolledTooltip
} from 'reactstrap';

import { DISCORD_INVITE } from 'scbl-lib/config';

import { ColorModeToggle } from '../../components';
import Auth from '../../utils/auth.js';

import logo from '../../assets/img/brand/cbl-logo.png';
import logoDark from '../../assets/img/brand/cbl-logo-dark.png';

class DemoNavbar extends React.Component {
  componentDidMount() {
    const headroom = new Headroom(document.getElementById('navbar-main'));
    headroom.init();
  }
  state = {
    collapseClasses: '',
    collapseOpen: false
  };

  onExiting = () => {
    this.setState({
      collapseClasses: 'collapsing-out'
    });
  };

  onExited = () => {
    this.setState({
      collapseClasses: ''
    });
  };

  render() {
    return (
      <>
        <header className="header-global">
          <Navbar
            className="navbar-main navbar-transparent headroom"
            expand="lg"
            container={false}
            id="navbar-main"
          >
            <Container>
              <NavbarBrand className="me-lg-5" to="/" tag={Link}>
                <img alt="CBL Logo" src={logo} />
              </NavbarBrand>
              <button className="navbar-toggler" id="navbar">
                <span className="navbar-toggler-icon" />
              </button>
              <UncontrolledCollapse
                toggler="#navbar"
                navbar
                className={this.state.collapseClasses}
                onExiting={this.onExiting}
                onExited={this.onExited}
              >
                <div className="navbar-collapse-header">
                  <Row>
                    <Col className="collapse-brand" xs="6">
                      <Link to="/">
                        <img alt="CBL Logo" className="logo-for-light-mode" src={logoDark} />
                        <img alt="CBL Logo" className="logo-for-dark-mode" src={logo} />
                      </Link>
                    </Col>
                    <Col className="collapse-close" xs="6">
                      <button className="navbar-toggler" id="navbar">
                        <span />
                        <span />
                      </button>
                    </Col>
                  </Row>
                </div>
                <Nav className="navbar-nav-hover align-items-lg-center" navbar>
                  <UncontrolledDropdown nav>
                    <DropdownToggle nav>
                      <i className="fa fa-search" />
                      <span className="nav-link-inner--text ms-2">Explore</span>
                    </DropdownToggle>
                    <DropdownMenu className="dropdown-menu-xl">
                      <div className="dropdown-menu-inner">
                        <Link className="dropdown-media" to="/search">
                          <div className="icon icon-shape bg-gradient-primary rounded-circle text-white">
                            <i className="fa fa-search" />
                          </div>
                          <div className="ms-3">
                            <h6 className="heading text-primary mb-md-1">Search</h6>
                            <p className="description d-none d-md-inline-block mb-0">
                              Search our database containing over 90,000 bans and 110,000 players.
                            </p>
                          </div>
                        </Link>
                        <Link className="dropdown-media" to="/recent-bans">
                          <div className="icon icon-shape bg-gradient-primary rounded-circle text-white">
                            <i className="fa fa-clock" />
                          </div>
                          <div className="ms-3">
                            <h6 className="heading text-primary mb-md-1">Recent Bans</h6>
                            <p className="description d-none d-md-inline-block mb-0">
                              View players recently banned on one of our many partner organisations.
                            </p>
                          </div>
                        </Link>
                        <Link className="dropdown-media" to="/most-harmful-players">
                          <div className="icon icon-shape bg-gradient-primary rounded-circle text-white">
                            <i className="fa fa-list" />
                          </div>
                          <div className="ms-3">
                            <h6 className="heading text-primary mb-md-1">Most Harmful Players</h6>
                            <p className="description d-none d-md-inline-block mb-0">
                              Explore a list of the most harmful players in our database.
                            </p>
                          </div>
                        </Link>
                        <Link className="dropdown-media" to="/most-harmful-players-this-month">
                          <div className="icon icon-shape bg-gradient-primary rounded-circle text-white">
                            <i className="fa fa-list" />
                          </div>
                          <div className="ms-3">
                            <h6 className="heading text-primary mb-md-1">
                              Most Harmful Players This Month
                            </h6>
                            <p className="description d-none d-md-inline-block mb-0">
                              Explore a list of the most harmful players in our database from this
                              month.
                            </p>
                          </div>
                        </Link>
                      </div>
                    </DropdownMenu>
                  </UncontrolledDropdown>
                  <UncontrolledDropdown nav>
                    <DropdownToggle nav>
                      <i className="fa fa-angle-double-down" />
                      <span className="nav-link-inner--text ms-2">Benefit</span>
                    </DropdownToggle>
                    <DropdownMenu className="dropdown-menu-xl">
                      <div className="dropdown-menu-inner">
                        <Link className="dropdown-media" to="/export-ban-lists">
                          <div className="icon icon-shape bg-gradient-info rounded-circle text-white">
                            <i className="fa fa-angle-double-down" />
                          </div>
                          <div className="ms-3">
                            <h6 className="heading text-info mb-md-1">Export Ban Lists</h6>
                            <p className="description d-none d-md-inline-block mb-0">
                              Protect your Squad server with our configurable export ban lists that
                              preemptively ban the most harmful players from your server before they
                              have the chance to cause any harm.
                            </p>
                          </div>
                        </Link>
                      </div>
                    </DropdownMenu>
                  </UncontrolledDropdown>
                  <UncontrolledDropdown nav>
                    <DropdownToggle nav>
                      <i className="fa fa-angle-double-up" />
                      <span className="nav-link-inner--text ms-2">Contribute</span>
                    </DropdownToggle>
                    <DropdownMenu className="dropdown-menu-xl">
                      <div className="dropdown-menu-inner">
                        <Link className="dropdown-media" to="/become-a-partner-organisation">
                          <div className="icon icon-shape bg-gradient-success rounded-circle text-white">
                            <i className="fa fa-angle-double-up" />
                          </div>
                          <div className="ms-3">
                            <h6 className="heading text-success mb-md-1">
                              Become a Partner Organisation
                            </h6>
                            <p className="description d-none d-md-inline-block mb-0">
                              Join the fight against harmful players by contributing ban information
                              to the Community Ban List!
                            </p>
                          </div>
                        </Link>
                        <a
                          className="dropdown-media"
                          href="https://github.com/community-ban-list/Communitybanlist"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <div className="icon icon-shape bg-github rounded-circle text-white">
                            <i className="fab fa-github" />
                          </div>
                          <div className="ms-3">
                            <h6 className="heading text-github mb-md-1">GitHub</h6>
                            <p className="description d-none d-md-inline-block mb-0">
                              Community Ban List is an open source project anyone can contribute to.
                              Find out more on our GitHub!
                            </p>
                          </div>
                        </a>
                      </div>
                    </DropdownMenu>
                  </UncontrolledDropdown>
                  <UncontrolledDropdown nav>
                    <DropdownToggle nav>
                      <i className="fa fa-question-circle" />
                      <span className="nav-link-inner--text ms-2">Help</span>
                    </DropdownToggle>
                    <DropdownMenu className="dropdown-menu-xl">
                      <div className="dropdown-menu-inner">
                        <Link className="dropdown-media" to="/faq">
                          <div className="icon icon-shape bg-gradient-warning rounded-circle text-white">
                            <i className="fa fa-question-circle" />
                          </div>
                          <div className="ms-3">
                            <h6 className="heading text-warning mb-md-1">FAQ</h6>
                          </div>
                        </Link>
                        <Link className="dropdown-media" to="/partner-organisation-list">
                          <div className="icon icon-shape bg-gradient-warning rounded-circle text-white">
                            <i className="fa fa-clipboard-list" />
                          </div>
                          <div className="ms-3">
                            <h6 className="heading text-warning mb-md-1">
                              Partner Organisation List
                            </h6>
                          </div>
                        </Link>
                        <Link className="dropdown-media" to="/banned">
                          <div className="icon icon-shape bg-gradient-warning rounded-circle text-white">
                            <i className="fa fa-life-ring" />
                          </div>
                          <div className="ms-3">
                            <h6 className="heading text-warning mb-md-1">I'm banned, what now?</h6>
                            <p className="description d-none d-md-inline-block mb-0">
                              Get information on how to get unlisted from or unbanned by Community
                              Ban List.com
                            </p>
                          </div>
                        </Link>
                      </div>
                    </DropdownMenu>
                  </UncontrolledDropdown>
                </Nav>
                <Nav className="navbar-nav-hover align-items-lg-center ms-lg-auto" navbar>
                  <ColorModeToggle />
                  <NavItem>
                    <NavLink
                      className="nav-link-icon"
                      href={DISCORD_INVITE}
                      id="tooltip-discord"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <i className="fab fa-discord" />
                      <span className="nav-link-inner--text d-lg-none ms-2">Discord</span>
                    </NavLink>
                    <UncontrolledTooltip delay={0} target="tooltip-discord">
                      Join our Discord!
                    </UncontrolledTooltip>
                  </NavItem>
                  <NavItem>
                    <NavLink
                      className="nav-link-icon"
                      href="https://github.com/community-ban-list/Communitybanlist"
                      id="tooltip-github"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <i className="fab fa-github" />
                      <span className="nav-link-inner--text d-lg-none ms-2">Github</span>
                    </NavLink>
                    <UncontrolledTooltip delay={0} target="tooltip-github">
                      Check us out on GitHub!
                    </UncontrolledTooltip>
                  </NavItem>

                  {Auth.isLoggedIn ? (
                    <UncontrolledDropdown nav>
                      <DropdownToggle nav>
                        <span className="d-flex align-items-center">
                          <span className="avatar avatar-sm rounded-circle me-2">
                            <img alt="..." src={Auth.claim.avatar} />
                          </span>
                          {Auth.claim.name}
                        </span>
                      </DropdownToggle>
                      <DropdownMenu className="dropdown-menu-md">
                        <DropdownItem
                          onClick={() => {
                            Auth.logout();
                            this.setState({});
                          }}
                        >
                          <i className="fas fa-sign-out-alt me-2" />
                          Logout
                        </DropdownItem>
                      </DropdownMenu>
                    </UncontrolledDropdown>
                  ) : (
                    <Button color="steam" tag={Link} to="/login">
                      <i className="fab fa-steam me-2" />
                      Login
                    </Button>
                  )}
                </Nav>
              </UncontrolledCollapse>
            </Container>
          </Navbar>
        </header>
      </>
    );
  }
}

export default DemoNavbar;
