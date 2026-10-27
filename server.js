//API FRAMEWORD
const express = require('express');
//CROSS ORIGIN RESOURCE SHARING
const cors = require('cors');
//ENVIRONMENT VARIABLES
const path = require("path");

const envResult = require("dotenv").config({
    path: path.join(__dirname, ".env")
});

if (envResult.error) {
    console.error("ENV LOAD ERROR:", envResult.error.message);
}

console.log(
    "OMR COUNTING STATUS:",
    JSON.stringify(process.env.OMR_COUNTING_ENABLED)
);
//DATABASE CONNECTION
const db=require('./config/db.js');
//ROUTES
const routes = require('./routes/index.js');
//UTILIZATION OF EXPRESS
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({extended:true})) //this will allow to read the url body tags

app.use((req,res,next)=>{
 req.cookies={};
 for(const part of (req.headers.cookie || '').split(';')) {
  const i=part.indexOf('='); if(i<0) continue;
  try {req.cookies[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1));} catch {}
 }
 next();
});
//use routes
app.use('/api', routes)

app.use(express.static(require('path').join(__dirname,'../voting-frontend-/Frontend')));
const port=process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
})