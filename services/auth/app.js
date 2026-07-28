import express from "express";
import router from "./routes/index.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import "dotenv/config";

const app = express();

app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(router);
app.use(errorHandler);

export default app;
