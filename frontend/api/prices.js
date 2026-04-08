module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');

  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=okb&vs_currencies=usd'
    );
    const data = await r.json();
    res.status(200).json({
      okb: data.okb ? data.okb.usd : 48.0,
      usdt: 1.0,
    });
  } catch (err) {
    // Fallback prices if CoinGecko is unavailable
    res.status(200).json({ okb: 48.0, usdt: 1.0 });
  }
};
