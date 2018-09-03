var express = require('express');
var natural = require('natural');
var shuffle = require('shuffle-array');
const tf = require('@tensorflow/tfjs');
require('@tensorflow/tfjs-node');
const arr = require('../Libs/ExtraFunctions');
const BotConfig = require('../Libs/BotConfig');
var synonymModel = require('../models/synonyms');
var intentsModels = require('../models/intents');

var router = express.Router();

//intents array
var intents = [];

//synonyms array
var synonyms = [];

//confidence to respond
var CONFIDENCE = BotConfig.BotConfidence.medium;
//load bot name
var BotName = BotConfig.BotName;

//path to model already save
var modelpath = __dirname.replace('routes','models/training-models');

var words = [], classes = [], documents = [], ignore_words = ['?'];

//Training data
var training = new Array();

//lock for build agent
var isAgentBuilding = false;

//context for intents
var context = [];

//init modules and training
BuildAgent(false);

/* GET home page. */
router.get('/', async (req, res, next) => {
  res.render('chat', { title: 'Tensorflow JS' }); 
});

router.post('/build', async (req, res, next) => {  
  if(isAgentBuilding == false){
    try {
      //init modules and training
      await BuildAgent(true);
      //responde
      res.status(200).end('Agent built');
    } catch (error) {
      console.error(error);
      res.status(500).end('Erro on build agent');
    }    
  }else{
    res.status(403).end('Agent are building');
  }  
});

router.post('/intent/new', async (req, res, next) => { 
  if(req.body.tag && req.body.title){
    intentsModels.find({tag: req.body.tag},function(err,Inte){
      if(err){
        console.error(err);
        res.status(500).end('Error');
      }
      if(Inte === undefined || Inte.length == 0){
        var newIntent = {
          tag : req.body.tag,
          patterns: JSON.parse(req.body.patterns),
          title: req.body.title,
          responses: JSON.parse(req.body.response),          
        }
        intentsModels.create(newIntent).then(()=>{
          res.status(200).end('Intent created');
        }).catch((e)=>{
          console.error(e);
          res.status(500).end('Internal error');
        })
      }else{
        res.status(403).end('Tag already exist.');
      }
    })
  }
});

router.post('/intent/delete', function(req, res) { 
  intentsModels.remove({tag: req.body.tag}, function(err) {
    if (!err) {
      res.status(200).end('Intent deleted');
    }
    else {
      console.error(err)
      res.status(500).end('Error');
    }
  });  
});

/* POST get response from bot. */
router.post('/ask',async (req, res, next) => {  
  try {
    var resp = await response(req.body.say,req.body.uID,true);
    res.status(200).end(resp);
  } catch (error) {
    res.status(500).end(error);
  }   
});

async function clean_up_sentence(sentence){  
    var tokenizer = new natural.WordTokenizer();
    //stem and tokenize the pattern
    sentence_words = await tokenizer.tokenize(sentence);

    await synonymModel.find({},function(err,synonym){
      synonyms =  synonym.length > 0 ?  synonym : require('../Libs/synonyms');
    });

    //if exist a synonym for the words in the list they will be replaced with their synonym
    await sentence_words.forEach(function(word,i){
      synonyms.forEach(function(syn){           
        syn.synonyms.forEach(function(syns){
          natural.LancasterStemmer.attach();
          if(syns.toLowerCase() == word.toLowerCase()){
            sentence_words[i] = word.replace(word,syn.keyWord).toLowerCase().stem();
          }else{
            sentence_words[i] = sentence_words[i].toLowerCase().stem();
          }
        })       
      })
    })   

    //return wordslist
    return sentence_words;
}

async function bow(sentence, show_details){
  //tokenize the pattern
  var sentence_words = await clean_up_sentence(sentence);
  //bag of words
  var bag = new Array(words.length + 1).join('0').split('').map(parseFloat);
  sentence_words.forEach(function(s, i){ 
    words.forEach(function(v, ii){ 
      if(v == s){
        //set 1 if found the match word and 0 for the others
        bag[ii] = 1;
        if(show_details){console.log("found in bag: "+v)}
      }
    });
  });
  return bag;       
}

async function classify(sentence){
  //load model
  var model = await tf.loadModel('file://'+modelpath+'/model.json');
  //bow sentence
  const bowData = await bow(sentence, true);
  //converter to tensor array
  var data = await tf.tensor2d(bowData, [1, bowData.length]);
    //generate probabilities from the model
  var predictions = await model.predict(data).dataSync();
  //filter out predictions below a threshold    
  var results = [];
  predictions.map((prediction, index, array) => {
    if(prediction > CONFIDENCE){
      results.push([index,prediction]);
    }      
  });
  //sort by strength of probability    
  results.sort(function(a, b){return a - b}).reverse();
  var return_list = [];
  results.forEach(function(r, i){ 
    return_list.push([classes[r[0]],r[1]]);
  });
  //return tuple of intent and probability
  return return_list
}

async function response(sentence,userID,show_details){ 
  var reply = arr.randomchoice(await GetFallBack());
  var i = 0;
  var results = await classify(sentence);  
  //if we have a classification then find the matching intent tag
  if (results){
    //loop as long as there are matches to process
    while (results[i]) {
      intents.forEach(function(s, i){ 
        //set context for this intent if necessary
        if(s.tag == results[0][0]){
           if(arr.inArray('context_set',s)){
              setContext(userID,s['context_set']);            
              if (show_details){
                console.log('context: ' +s['context_set'])
              }
            }
           //check if this intent is contextual and applies to this user's conversation
           if(!arr.inArray('context_filter',s) || arr.UserFilter(context,userID) &&  arr.inArray('context_filter',s) && s['context_filter'] == context[context.findIndex(x => x.uID== userID)].ctx){
            if (show_details){
              console.log('tag: ' +s['tag']);
            }            
            //a random response from the intent             
            reply = arr.randomchoice(s['responses']);                         
           }
        }
      });     
      results.shift();
      i++;
    }
  }
  return reply;
}

function setContext(userid,contextText){
  if(!arr.UserFilter(context,userid)){
    context.push({uID:userid, ctx:contextText})
  }else{
    context[context.findIndex(x => x.uID== userid)].context = contextText;
  }
}

async function BuildAgent(fullbuild){ 
    isAgentBuilding = true;
    await intentsModels.find({},async (err,inte) =>{
      intents =  inte.length > 0 ?  inte : require('../Libs/intents');
    });
    
    var wwd = [];
    documents = [];
    classes = [];

    intents.forEach(async (intent, ii) =>{
      intent.patterns.forEach(async (pattern, i) =>{  
        //stem and tokenize each word in the sentence     
        var tokenizer = new natural.WordTokenizer();
        var wd = tokenizer.tokenize(pattern);      
        //add to words list     
        wwd.push(wd);
        //add to documents in corpus
        documents.push([wd,intent.tag]);       
        //add the tag to classes list 
        if(!arr.ContainsinArray(classes,intent.tag)){
          classes.push(intent.tag);
        }
      });
    });
    //stem and lower each word
    words = wwd.map((iten, index, array) => {
      return iten.map((w, i, a) => {
        natural.LancasterStemmer.attach();
        w = w.toLowerCase().stem();
        return w;
      }); 
    })     
    //stem and lower each word and remove duplicates 
    words = arr.ignore_wordsFilter(arr.sort(arr.toOneArray(words)),ignore_words);
    //lower each word and remove duplicates
    classes = arr.sort(classes);  

    console.log(' ');
    console.log('Words list builded.')
 
    if(fullbuild){
      console.log(' ');
      console.log('Training...'); 
      await TrainBuilder().catch(console.error);  
    }else{
      console.log(' ');
      console.log("documents "+ documents.length);
      console.log("classes "+classes.length);
      console.log("unique stemmed words "+ words.length);
    }       
  
    isAgentBuilding = false;

    console.log(' ');
    console.log('Training finished'); 
}

async function TrainBuilder(){ 
  documents.forEach(async (doc, i) =>{
    //initialize bag of words
    var bag = [];
    //list of tokenized words for the pattern and stem each word
    var pattern_words = doc[0].map((it, i, A) => {
      natural.LancasterStemmer.attach();
      it = it.toLowerCase().stem();
      return it;
    });    
    //create bag of words array
    words.forEach(async (word, ii) =>{
      if(!arr.NotcontainsinArray(pattern_words,word)){
        bag.push(1);
      }else{
        bag.push(0);
      }
    });
    //create an empty array for output
    var output_row = new Array(classes.length + 1).join('0').split('').map(parseFloat);
    // set '0' for each tag and '1' for current tag
    output_row[classes.findIndex(x => x==doc[1])] = 1;  
    //push on the arrays de values  
    training.push([bag, output_row]);
  });
  //shuffle features
  training = shuffle(training);
 
  //create train arrays
  var train_x = arr.pick(training,0);
  var train_y = arr.pick(training,1);
  try {
    // Build neural network:
    const model = tf.sequential();
    model.add(tf.layers.dense({units: training.length, activation: 'relu', inputShape: [train_x[0].length]}));
    model.add(tf.layers.dense({units: train_y[0].length, activation: 'linear'}));
    model.compile({optimizer: 'sgd', loss: 'meanSquaredError'});

    const xs = tf.tensor(train_x);
    const ys = tf.tensor(train_y);

    //train model
    await model.fit(xs, ys, {
      epochs: 1000,
      batchSize: 8,
      callbacks: {
        onEpochEnd: async (epoch, log) => {
          console.log(`Epoch ${epoch}: loss = ${log.loss}`);        
        }
      }
    }).then(async () => {
        console.log('Saving model....'); 
        await model.save('file://'+modelpath).then(async ()=>{
          console.log(' ');
          console.log('Model Saved.');     
          console.log(' ');
          console.log("documents "+ documents.length);
          console.log("classes "+classes.length);
          console.log("unique stemmed words "+ words.length);
        });    
    });
  } catch (error) {
    console.error(error)
  }
  
}

async function GetFallBack(){ 
  let rt = ["What did you mean ?","I'm not understanding you"];
  intents.forEach((intent)=>{
    if(intent.tag == 'fallback'){
      rt = intent.responses
    }  
  })     
  return rt;
}

module.exports = router;
