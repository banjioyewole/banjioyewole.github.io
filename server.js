var DEFAULT_PORT = 3000;


var express = require("express");
var app     = express();
var path    = require("path");
var multer  =   require('multer');
var favicon = require('serve-favicon');
var sharp = require('sharp');
// var resizeImage = require('resize-image');
var colors = require('colors');

var debug = true;


var mongoose = require('mongoose');
require('./models/db');

var Img = mongoose.model('Imagery')
var ipSchema = mongoose.model('IP_Scheme')


var storage =   multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, __dirname+ '/public/uploads');
  },
  filename: function (req, file, callback) {
    callback(null, 'efarrari' + '-' + Date.now() + getExtension(file.originalname));
  },

});

var upload = multer({ storage : storage});
var uploadia = upload.single('userPhoto');



app.get('/api/ip_disco', function (req, res){
  //
  //
  // var whois = req.param('whois');
  // var ip_address = req.param('ip_address');

  ipSchema.create({
    whois : req.param('whois'),
    ip_address : req.param('ip_address')

  }, null);

  console.log("Recieved IP from " + req.param('whois'))
  sendJsonResponse(res, 200, 'OK TNX :D');



});

app.post('/api/photo', upload.single('userPhoto'), function (req, res) {





  sharp(req.file.path)
    .resize(512)
    .toFile('./public/uploads'+'/efarrari_thumb'+ '-' +req.file.filename , function(err) {
      // output.jpg is a 300 pixels wide and 200 pixels high image
      // containing a scaled and cropped version of input.jpg
    });

  Img.create(
    {
    name: req.body.name,
    sensor: req.body.sensor,
    date: req.body.date,
    pack: req.body.pack,
    url : stripPublic(req.file.path),
    thumb: '/uploads'+'/efarrari_thumb'+ '-' +req.file.filename,
    location: req.body.location
    }
    , null);


  uploadia(req,res,function(err) {
         if(err) {
             return res.end("Error uploading file.");
         }
         res.end("File is uploaded");
     });
});


app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));
app.use(express.static(path.join(__dirname, '/img')));
app.use(express.static(__dirname + '/public'));
app.use(express.static(__dirname + '/css'));
app.use(express.static(__dirname + '/views'));
app.use(express.static(__dirname + '/js'));


app.get('',function(req,res){
  console.log(colors.white.bgCyan(req.headers));
  // console.log(res);
      res.sendFile(__dirname + "/views/index_core.html");
});


app.get('/woo',function(req,res){
  console.log(colors.white.bgCyan(req.headers));
  // console.log(res);
      res.sendFile(__dirname + "/views/sample.html");
});

app.get('/',function(req,res){
  console.log(colors.white.bgCyan(req.headers));
  // console.log(res);
      res.sendFile(__dirname + "/views/index_core.html");
});

app.get('/efarrari',function(req,res){
  res.sendFile(path.join(__dirname+'/views/efarrari.html'));
  //__dirname : It will resolve to your project folder.
});

  app.get('/software',function(req,res){
    res.sendFile(path.join(__dirname+'/views/software.html'));
    //__dirname : It will resolve to your project folder.
  });


  app.get('/design',function(req,res){
    res.sendFile(path.join(__dirname+'/views/design.html'));
    //__dirname : It will resolve to your project folder.
  });

  app.get('/myngo',function(req,res){
    res.sendFile(path.join(__dirname+'/views/myngo.html'));
    //__dirname : It will resolve to your project folder.
  });

  app.get('/hd_project',function(req,res){
    res.sendFile(path.join(__dirname+'/views/hd_project.html'));
    //__dirname : It will resolve to your project folder.
  });


  app.get('/material_flashlight',function(req,res){
    res.sendFile(path.join(__dirname+'/views/material_flashlight.html'));
    //__dirname : It will resolve to your project folder.
  });

app.get('/material_flashlight/privacy_policy',function(req,res){
  res.sendFile(path.join(__dirname+'/views/material_privacy.html'));
  //__dirname : It will resolve to your project folder.
});


app.get('/projects/capstone/video',function(req,res){
  res.sendFile(path.join(__dirname+'/views/capstone_videos.html'));
  //__dirname : It will resolve to your project folder.
});





app.get('/ip_disco', function(req, res){

var ip_addresses = [];

ipSchema.find(null, null, null, function (err, docs) {
  console.log(docs);

  docs.forEach(function(doc) {
        ip_addresses.push(doc);
})

sendJsonResponse(res, 200, ip_addresses);
  //__dirname : It will resolve to your project folder.

  });

});

app.get('/efarrari/source',function(req,res){
  console.log(colors.white.bgCyan(humanReadableDate()));
  // res.sendFile(path.join(__dirname+'/views/efarrari.html'));

  var locations = [];

Img.find(null, null, null, function (err, docs) {
  console.log(docs);

// locations.push(docs);
  docs.forEach(function(doc) {
        //  locations.push(doc)
        locations.push(doc
          // {doc.obj.ip_address, doc.obj.whois}
      // distance: theEarth.getDistanceFromRads(doc.dis),
      // name: doc.name
      // address: doc.obj.address,
      // rating: doc.obj.rating,
      // facilities: doc.obj.facilities,
      // _id: doc.obj._id

);
// locations.push("Most Recent at Bottom!")
})
sendJsonResponse(res, 200, locations);
  //__dirname : It will resolve to your project folder.
});

});
app.get('/efarrari/upload',function(req,res){
  res.sendFile(path.join(__dirname+'/views/upload.html'));
  //__dirname : It will resolve to your project folder.
});

app.get('/about',function(req,res){
  res.sendFile(path.join(__dirname+'/about.html'));

});

app.get('/sitemap',function(req,res){
  res.sendFile(path.join(__dirname+'/sitemap.html'));
});


// catch 404 and forward to error handler
app.use(function(req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;
  res.sendFile(path.join(__dirname+'/views/not_found.html'));
  // next(err);
});

var sendJsonResponse = function(res, status, content) {
  res.status(status);
  res.json(content);
};



// app.listen(config.port, config.host, function () {
//   console.long("Working on port " + config.port)
// }
app.listen((process.env.PORT || DEFAULT_PORT),function(){
    console.log("Working on port " + (process.env.PORT || DEFAULT_PORT));
});

function getExtension(filename) {

  if(debug)
  console.log(filename);
  while (filename.substring(1).indexOf('.') !== -1)
    filename = filename.substring(1).substring(filename.indexOf('.'));

    return filename; //returns extention of the file;
}

function stripPublic(path){
  //TODO: this is what's causing the images to be inaccessible


  var varia = path;

  // console.log(varia);

  var cutIndex = varia.indexOf("public") + "public".length;

  // console.log(varia.substring(cutIndex));

  return varia.substring(cutIndex);

}

function humanReadableDate(){
  var time = new Date();
  var year = time.getFullYear();
  var month = time.getMonth()+1;
  var date1 = time.getDate();
  var hour = time.getHours();
  var minutes = time.getMinutes();
  var seconds = time.getSeconds();
  return "Accessed at: "+  year + "-" + month+"-"+date1+" "+hour+":"+minutes+":"+seconds;

}
