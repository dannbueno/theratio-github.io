const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const querystring = require('querystring');

const app = express();
const PORT = 3000;

const client_id = '108813';  // Reemplaza con tu client_id real
const client_secret = '936685973d7745db024bfbafbae9af123e0f5af5';  // Reemplaza con tu client_secret real
const redirect_uri = 'http://localhost:3000/callback';  // Asegúrate de que esta URL coincida con la configurada en Strava

let db = new sqlite3.Database('./strava.db', (err) => {
    if (err) {
        console.error(err.message);
    }
    console.log('Connected to the SQLite database.');
});

db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    access_token TEXT,
    refresh_token TEXT,
    expires_at INTEGER
)`);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.get('/', (req, res) => {
    res.send('<a href="/authorize">Authorize with Strava</a>');
});

app.get('/authorize', (req, res) => {
    const authUrl = `https://www.strava.com/oauth/authorize?${querystring.stringify({
        client_id: client_id,
        response_type: 'code',
        redirect_uri: redirect_uri,
        scope: 'activity:read_all,activity:write',
        approval_prompt: 'force'
    })}`;
    res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
    const code = req.query.code;

    try {
        const response = await axios.post('https://www.strava.com/oauth/token', {
            client_id: client_id,
            client_secret: client_secret,
            code: code,
            grant_type: 'authorization_code'
        });

        const { access_token, refresh_token, expires_at } = response.data;

        db.run(`INSERT INTO users (access_token, refresh_token, expires_at) VALUES (?, ?, ?)`,
            [access_token, refresh_token, expires_at], function (err) {
                if (err) {
                    return console.log(err.message);
                }
                console.log(`A row has been inserted with rowid ${this.lastID}`);
            });

        res.redirect('/activities');
    } catch (error) {
        console.error(error);
        res.send('Error exchanging code for token');
    }
});

app.get('/activities', async (req, res) => {
    db.get(`SELECT access_token, refresh_token, expires_at FROM users ORDER BY id DESC LIMIT 1`, async (err, row) => {
        if (err) {
            console.error(err.message);
            res.status(500).send('Database error');
            return;
        }

        if (!row) {
            res.redirect('/authorize');
            return;
        }

        const { access_token, refresh_token, expires_at } = row;

        let currentAccessToken = access_token;

        if (expires_at < Math.floor(Date.now() / 1000)) {
            try {
                const response = await axios.post('https://www.strava.com/oauth/token', {
                    client_id: client_id,
                    client_secret: client_secret,
                    refresh_token: refresh_token,
                    grant_type: 'refresh_token'
                });

                currentAccessToken = response.data.access_token;

                db.run(`UPDATE users SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = ?`,
                    [response.data.access_token, response.data.refresh_token, response.data.expires_at, row.id], function (err) {
                        if (err) {
                            return console.log(err.message);
                        }
                        console.log(`Row updated with rowid ${this.lastID}`);
                    });
            } catch (error) {
                console.error(error);
                res.send('Error refreshing access token');
                return;
            }
        }

        try {
            const activitiesResponse = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
                headers: {
                    'Authorization': `Bearer ${currentAccessToken}`
                }
            });

            const activities = activitiesResponse.data.map(activity => {
                const distance_km = activity.distance / 1000;
                const elevation_gain_m = activity.total_elevation_gain;
                const ratio = distance_km > 0 ? (elevation_gain_m / distance_km).toFixed(1) : 0;
                return {
                    ...activity,
                    ratio
                };
            });

            // Update activity descriptions with ratio
            for (const activity of activities) {
                if (activity.ratio > 0) {
                    const newDescription = `${activity.description || ''}\nRatio de desnivel: ${activity.ratio} m/km`;
                    await axios.put(`https://www.strava.com/api/v3/activities/${activity.id}`, {
                        description: newDescription
                    }, {
                        headers: {
                            'Authorization': `Bearer ${currentAccessToken}`
                        }
                    });
                }
            }

            res.json(activities);
        } catch (error) {
            console.error(error);
            res.send('Error fetching activities');
        }
    });
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
