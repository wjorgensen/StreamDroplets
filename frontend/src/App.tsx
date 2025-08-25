import { useState, useEffect } from 'react';
import axios from 'axios';
import { Search, Trophy, Droplets, TrendingUp } from 'lucide-react';
import './App.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

interface LeaderboardEntry {
  rank: number;
  address: string;
  droplets: string;
  breakdown: {
    xETH: string;
    xBTC: string;
    xUSD: string;
    xEUR: string;
  };
}

interface UserDroplets {
  address: string;
  droplets: string;
  breakdown: {
    xETH: string;
    xBTC: string;
    xUSD: string;
    xEUR: string;
  };
}

function App() {
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [searchAddress, setSearchAddress] = useState('');
  const [userDroplets, setUserDroplets] = useState<UserDroplets | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchLeaderboard();
  }, []);

  const fetchLeaderboard = async () => {
    try {
      const response = await axios.get(`${API_URL}/leaderboard?limit=10`);
      setLeaderboard(response.data.data || []);
    } catch (err) {
      console.error('Failed to fetch leaderboard:', err);
    }
  };

  const searchUserDroplets = async () => {
    if (!searchAddress || !searchAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
      setError('Please enter a valid Ethereum address');
      return;
    }

    setLoading(true);
    setError('');
    setUserDroplets(null);

    try {
      const response = await axios.get(`${API_URL}/points/${searchAddress}`);
      setUserDroplets(response.data);
    } catch (err: any) {
      if (err.response?.status === 404) {
        setError('Address not found or has no droplets');
      } else {
        setError('Failed to fetch droplets. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const formatNumber = (num: string) => {
    const value = parseFloat(num);
    if (value >= 1000000) return `${(value / 1000000).toFixed(2)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(2)}K`;
    return value.toFixed(2);
  };

  const formatAddress = (address: string) => {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  return (
    <div className="app">
      <header className="header">
        <div className="container">
          <div className="nav">
            <div className="logo">
              <Droplets className="logo-icon" />
              <span className="logo-text">Stream Droplets</span>
            </div>
            <div className="header-stats">
              <div className="tvl">
                <span className="tvl-label">TVL</span>
                <span className="tvl-value">$176.75M</span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="main">
        <div className="container">
          <div className="hero">
            <h1 className="hero-title">Stream Droplets Tracker</h1>
            <p className="hero-subtitle">
              Track your rewards across all Stream vaults
            </p>
          </div>

          {/* Search Section */}
          <div className="search-section">
            <div className="search-card">
              <h2 className="section-title">
                <Search className="section-icon" />
                Check Your Droplets
              </h2>
              <div className="search-container">
                <input
                  type="text"
                  placeholder="Enter wallet address (0x...)"
                  value={searchAddress}
                  onChange={(e) => setSearchAddress(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && searchUserDroplets()}
                  className="search-input"
                />
                <button
                  onClick={searchUserDroplets}
                  disabled={loading}
                  className="search-button"
                >
                  {loading ? 'Searching...' : 'Search'}
                </button>
              </div>
              
              {error && (
                <div className="error-message">{error}</div>
              )}
              
              {userDroplets && (
                <div className="user-results">
                  <div className="droplets-total">
                    <div className="droplets-label">Total Droplets</div>
                    <div className="droplets-value">
                      {formatNumber(userDroplets.droplets)}
                    </div>
                  </div>
                  
                  <div className="breakdown-grid">
                    <div className="breakdown-item xeth">
                      <span className="asset-label">xETH</span>
                      <span className="asset-value">
                        {formatNumber(userDroplets.breakdown.xETH)}
                      </span>
                    </div>
                    <div className="breakdown-item xbtc">
                      <span className="asset-label">xBTC</span>
                      <span className="asset-value">
                        {formatNumber(userDroplets.breakdown.xBTC)}
                      </span>
                    </div>
                    <div className="breakdown-item xusd">
                      <span className="asset-label">xUSD</span>
                      <span className="asset-value">
                        {formatNumber(userDroplets.breakdown.xUSD)}
                      </span>
                    </div>
                    <div className="breakdown-item xeur">
                      <span className="asset-label">xEUR</span>
                      <span className="asset-value">
                        {formatNumber(userDroplets.breakdown.xEUR)}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Leaderboard Section */}
          <div className="leaderboard-section">
            <div className="leaderboard-card">
              <h2 className="section-title">
                <Trophy className="section-icon" />
                Top Droplet Earners
              </h2>
              
              <div className="leaderboard-table">
                <div className="table-header">
                  <div className="table-cell rank">Rank</div>
                  <div className="table-cell address">Address</div>
                  <div className="table-cell droplets">Total Droplets</div>
                  <div className="table-cell breakdown">Breakdown</div>
                </div>
                
                {leaderboard.map((entry) => (
                  <div key={entry.address} className="table-row">
                    <div className="table-cell rank">
                      {entry.rank <= 3 ? (
                        <span className={`rank-badge rank-${entry.rank}`}>
                          {entry.rank}
                        </span>
                      ) : (
                        <span className="rank-number">{entry.rank}</span>
                      )}
                    </div>
                    <div className="table-cell address">
                      <span className="mono">{formatAddress(entry.address)}</span>
                    </div>
                    <div className="table-cell droplets">
                      <TrendingUp className="inline-icon" />
                      {formatNumber(entry.droplets)}
                    </div>
                    <div className="table-cell breakdown">
                      <div className="breakdown-mini">
                        <span className="asset-mini xeth">
                          xETH: {formatNumber(entry.breakdown.xETH)}
                        </span>
                        <span className="asset-mini xbtc">
                          xBTC: {formatNumber(entry.breakdown.xBTC)}
                        </span>
                        <span className="asset-mini xusd">
                          xUSD: {formatNumber(entry.breakdown.xUSD)}
                        </span>
                        <span className="asset-mini xeur">
                          xEUR: {formatNumber(entry.breakdown.xEUR)}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="footer">
        <div className="container">
          <p className="footer-text">
            Stream Droplets Tracker · Deterministic reward tracking for Stream Protocol
          </p>
        </div>
      </footer>
    </div>
  );
}

export default App;