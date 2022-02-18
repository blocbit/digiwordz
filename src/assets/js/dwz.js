// SpeedReader class
function SpeedReader (input, startSpeed) {
  this.init = function () {
    var self = this;
    this.currentPlayPosition = 0;
    this.pauseButton = document.getElementById('playpause');
    this.wpmDisplay = document.getElementById('wpm');
    this.wpmInput = document.getElementById('wpm-slider');
    input.addEventListener('change', function (e) {
      self.load();
    });
    this.pauseButton.addEventListener('click', function (e) {
      self.togglePlayState();
    });
    this.wpmInput.addEventListener('change', function (e) {
      self.setWpm(e.target.value);
    });
    
    
  	this.currentSpeed = wpmToMs(startSpeed);
    
    self.load();
  } 
  this.load = function () {
    
    // Array of all words; new lines are replaced with spaces
    var raw = input.value;
    raw = raw.replace(/\n/g, ' ');
    var wordStrings = raw.split(' ');
    this.wordQueue = generateWords(wordStrings);
    this.pause();
  }
  
  this.togglePlayState = function () {
    if (this.playState == 'playing') {
      this.pause();
    } else {
      this.play();
    }
  }
  
  this.play = function (playAt) {
    this.playState = 'playing';
    this.pauseButton.className = "icon-pause";
    this.loop();
  }
  
  this.loop = function () {
    var slide = this.wordQueue[this.currentPlayPosition];
    this.showSlide(this.currentPlayPosition);
    this.currentPlayPosition++;
    
    if (this.playState == 'playing') {
      var self = this;
      if (slide instanceof Word) {
        setTimeout(function(){  self.loop(); }, this.currentSpeed);
      }
      if (slide instanceof Pause) {
        setTimeout(function(){ self.loop(); }, slide.duration * this.currentSpeed);
      }
    }
  }
  
  this.pause = function (pauseAt) {
    if (this.playState == 'playing') {
      this.playState = 'paused';
      this.pauseButton.className = "icon-play2";
      this.showSlide(pauseAt);
    }
  }
  
  this.showSlide = function (index) {
    var slide = this.wordQueue[index];
    if (typeof slide !== 'undefined') {
      slide.write();
    } else {
      this.pause(0);
      return;
    }
  }
  
  var generateWords = function (wordStrings) {
    var words = [];
    wordStrings.forEach(function (word) {
      words.push(new Word(word));
      if ('.!?'.indexOf(word.substr(-1)) > -1) {
        words.push(new Pause('fullstop'));
        return;
      }
      if ('...'.indexOf(word.substr(-3)) > -1) {
         words.push(new Pause('ellipsis'));
         return;
      }
      if (',:;'.indexOf(word.substr(-1)) > -1) {
        words.push(new Pause('comma'));
        return;
      }
    })
    return words;
  }
  
  this.setWpm = function (wpm) {
    this.currentSpeed = wpmToMs(wpm);
    this.wpmDisplay.innerText = wpm;
  }
  
  var wpmToMs = function (wpm) {
    perSecond = Math.round(wpm / 60);
    return Math.round(1000 / perSecond);
  }
  
  this.init();
}

// Word class
function Word (word) {
  var self = this;
  // Hidden element for calculations
  this.testWidth = document.getElementById('test-width');
  // Elements to write to
  this.containerEl = document.getElementById('container');
  this.centerCharEl = document.getElementById('center-character');
  this.leftStringEl = document.getElementById('left-string');
  this.rightStringEl = document.getElementById('right-string');

  this.center = self.middle(word);
  this.centerComponent = word.substr(this.center - 1, 1);
  this.leftComponent = word.substr(0, this.center - 1);
  this.rightComponent = word.substr(this.center);

  var leftOffset = function (word) {
    var leftWidth = self.width(self.leftComponent);
    var halfWidth = self.width(word.substr(0, self.center));
    var centerWidth = (halfWidth - leftWidth) / 2;
    var leftOffset = ~~(300 - (leftWidth + centerWidth)) + 'px';
    return ~~(300 - (leftWidth + centerWidth)) + 'px';
  }


  this.containerPaddingLeft = leftOffset(word);

}
Word.prototype = {
  middle: function (word) {
    var length = word.length;
    if (!length) return null;
    // Simple center-character calculation
    // google 'double tilde' 
    return ~~((length + 1) / 3) + 1;
  },
  
  width: function (string) {
    // Get the width of the block of text
    // useful for centering appropriately
    this.testWidth.textContent = string;
    return this.testWidth.offsetWidth;
  },

  write: function () {
    this.containerEl.style['padding-left'] = this.containerPaddingLeft;
    this.centerCharEl.textContent = this.centerComponent;
    this.leftStringEl.textContent = this.leftComponent;
    this.rightStringEl.textContent = this.rightComponent;
  }
}

window.onload = function () {
  var input = document.getElementById('input-text');
  var speedReaderDemo = new SpeedReader(input, 150) // 150 wpm start speed
 } 

function Pause (type) {

  var PauseTypes = {
    'fullstop': 1.5,
    'comma': 1,
    'ellipsis': 3
  }

  // Elements to write to
  this.containerEl = document.getElementById('container');
  this.centerCharEl = document.getElementById('center-character');
  this.leftStringEl = document.getElementById('left-string');
  this.rightStringEl = document.getElementById('right-string');

  this.duration = (function (type) {
    return PauseTypes[type]
  })(type);

  this.write = function () {
    // Do nothing. This space would be used to produce
    // whitespace pauses (by emptying the DOM).
    return;
  }

}