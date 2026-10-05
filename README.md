



## Run locally

```sh
npm install
npm start
```

Open `http://localhost:4200/`. If that port is already in use, run `npm start -- --port 4300` and open `http://localhost:4300/`.



## Verify

```sh
npm run build
npm test -- --watch=false --browsers=ChromeHeadless
```