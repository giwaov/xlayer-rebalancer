module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');

  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=okb&vs_currencies=usd',
      { signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) {
      return res.status(502).json({ error: 'CoinGecko returned ' + r.status });
    }
    const data = await r.json();
    if (!data.okb || !data.okb.usd) {
      return res.status(502).json({ error: 'Unexpected CoinGecko response' });
    }
    res.status(200).json({
      okb: data.okb.usd,
      usdt: 1.0,
    });
  } catch (err) {
    res.status(502).json({ error: 'Price feed unavailable: ' + err.message });
  }
};
