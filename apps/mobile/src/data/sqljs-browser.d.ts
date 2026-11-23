// The browser build of sql.js has the same API as the package's main entry.
declare module "sql.js/dist/sql-wasm-browser.js" {
  import initSqlJs from "sql.js";
  export default initSqlJs;
}
