const audioUtils        = require('./audioUtils');  // for encoding audio data as PCM
const crypto            = require('crypto'); // tot sign our pre-signed URL
const v4                = require('./aws-signature-v4'); // to generate our pre-signed URL
const marshaller        = require("@aws-sdk/eventstream-marshaller"); // for converting binary event stream messages to and from JSON
const util_utf8_node    = require("@aws-sdk/util-utf8-node"); // utilities for encoding and decoding UTF8
const mic               = require('microphone-stream'); // collect microphone input as a stream of raw bytes

// our converter between binary event streams messages and JSON
const eventStreamMarshaller = new marshaller.EventStreamMarshaller(util_utf8_node.toUtf8, util_utf8_node.fromUtf8);

// our global variables for managing state
let languageCode;
let region;
let sampleRate;
let transcription = "";
let socket;
let micStream;
let socketError = false;
let transcribeException = false;
let lastResponse = null;
let fillingWords = ["absolutely","actual","actually","amazing","anyway","apparently","approximately","badly","basically","begin","best","certainly","clearly","completely","definitely","easily","effectively","entirely","especially","essentially","exactly","extremely","fairly","frankly","frequently","fully","generally","hardly","heavily","highly","hopefully","just","largely","like","literally","maybe","might","most","mostly","much","necessarily","nicely","obviously","ok","okay","particularly","perhaps","possibly","practically","precisely","primarily","probably","quite","rather","real","really","relatively","right","seriously","significantly","simply","slightly","so","specifically","start","strongly","stuff","surely","things","too","totally","truly","try","typically","ultimately","usually","very","virtually","well","whatever","whenever","wherever","whoever","widely"];

// check to see if the browser allows mic access
if (!window.navigator.mediaDevices.getUserMedia) {
    // Use our helper method to show an error on the page
    showError('We support the latest versions of Chrome, Firefox, Safari, and Edge. Update your browser and try your request again.');

    // maintain enabled/distabled state for the start and stop buttons
    toggleStartStop();
}

$(document).ready(function () {

    // set the language and region from the dropdowns
    setLanguage();
    setRegion();

    // first we get the microphone input from the browser (as a promise)...
    window.navigator.mediaDevices.getUserMedia({
            video: false,
            audio: true
        })
        // ...then we convert the mic stream to binary event stream messages when the promise resolves 
        .then(streamAudioToWebSocket) 
        .catch(function (error) {
            showError('There was an error streaming your audio to Amazon Transcribe. Please try again.');
            toggleStartStop();
        });

    var modalBigContent = new tingle.modal();
    var btn3 = document.querySelector('#score-btn');
    btn3.addEventListener('click', function(){
        
        if (lastResponse.score < 50) {
            document.querySelector('.scoring').querySelector('.msg').innerHTML = 'You suck on stage! Your score is ' + lastResponse.score + '%';
        }
        else {
            document.querySelector('.scoring').querySelector('.msg').innerHTML = 'Great work, your score is ' + lastResponse.score + '%';
        }
        
        var ct = "";
        for (var i = 0; i < lastResponse.topFillerWords.length; i++) {
            ct += '<p style="margin: 0">' + lastResponse.topFillerWords[i].word + ': ' + lastResponse.topFillerWords[i].count + '</p>';
        }
        document.querySelector('.scoring').querySelector('.filler').innerHTML = ct;

        modalBigContent.setContent(document.querySelector('.scoring').innerHTML);
        modalBigContent.open();
    });
    

    let chartWidth = 400;

    let options = {
        hasNeedle: true,
        outerNeedle: true,
        needleColor: "#232f3e",
        needleStartValue: 1,
        arcColors: ["rgb(255,84,84)","rgb(239,214,19)","rgb(61,204,91)"],
        arcDelimiters: [40,60],
        centralLabel: "score",
    }

    let element = document.querySelector('#gauge');

    var chart = GaugeChart.gaugeChart(element, chartWidth, options);
    chart.updateNeedle(100);

    var lastTranscription = "";

    setInterval(function () {
        if (lastTranscription == transcription) {
            return;
        }

        lastTranscription = transcription;
        $.post({
            url: 'https://zv02spd0e3.execute-api.us-east-1.amazonaws.com/Prod/api/evaluation',
            data: JSON.stringify({
                text: transcription
            }),
            contentType: 'application/json',
            dataType: 'json',
            success: function (response) {
                console.log(response);
                chart.updateNeedle(response.score);
                lastResponse = response;
            }
        });

        // document.querySelector('body').style.backgroundColor = 'red';
        // setTimeout(function() {
        //     document.querySelector('body').style.backgroundColor = '#ff9900';
        // }, 100);

        // var words = transcription.split(' ');
        // var length = words.length;
        // var count = 0;
        // for (var i = 0; i < words.length; i++) {
        //     var match = false;
        //     for (var j = 0; j < fillingWords.length; j++) {
        //         if (words[i] == fillingWords[j]) {
        //             match = true;
        //             break;
        //         }
        //     }

        //     if (match === true) {
        //         count++;
        //     }
        // }
        // var percentage = ((count/length) * 100).toFixed(3);
        // percentage + Math.floor(Math.random() * 6) + 1 ;

        //chart.updateNeedle(percentage);
    }, 1000);
});

let streamAudioToWebSocket = function (userMediaStream) {
    //let's get the mic input from the browser, via the microphone-stream module
    micStream = new mic();
    micStream.setStream(userMediaStream);

    // Pre-signed URLs are a way to authenticate a request (or WebSocket connection, in this case)
    // via Query Parameters. Learn more: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    let url = createPresignedUrl();

    //open up our WebSocket connection
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";

    // when we get audio data from the mic, send it to the WebSocket if possible
    socket.onopen = function() {
        micStream.on('data', function(rawAudioChunk) {
            // the audio stream is raw audio bytes. Transcribe expects PCM with additional metadata, encoded as binary
            let binary = convertAudioToBinaryMessage(rawAudioChunk);

            if (socket.OPEN)
                socket.send(binary);
        }
    )};

    // handle messages, errors, and close events
    wireSocketEvents();
}

function setLanguage() {
    languageCode = 'en-US';
    if (languageCode == "en-US" || languageCode == "es-US")
        sampleRate = 44100;
    else
        sampleRate = 8000;
}

function setRegion() {
    region = 'us-east-1';
}

function wireSocketEvents() {
    // handle inbound messages from Amazon Transcribe
    socket.onmessage = function (message) {
        //convert the binary event stream message to JSON
        let messageWrapper = eventStreamMarshaller.unmarshall(Buffer(message.data));
        let messageBody = JSON.parse(String.fromCharCode.apply(String, messageWrapper.body));
        if (messageWrapper.headers[":message-type"].value === "event") {
            handleEventStreamMessage(messageBody);
        }
        else {
            transcribeException = true;
            showError(messageBody.Message);
            toggleStartStop();
        }
    };

    socket.onerror = function () {
        socketError = true;
        showError('WebSocket connection error. Try again.');
        toggleStartStop();
    };
    
    socket.onclose = function (closeEvent) {
        micStream.stop();
        
        // the close event immediately follows the error event; only handle one.
        if (!socketError && !transcribeException) {
            if (closeEvent.code != 1000) {
                showError('</i><strong>Streaming Exception</strong><br>' + closeEvent.reason);
            }
            toggleStartStop();
        }
    };
}

let handleEventStreamMessage = function (messageJson) {
    let results = messageJson.Transcript.Results;

    if (results.length > 0) {
        if (results[0].Alternatives.length > 0) {
            let transcript = results[0].Alternatives[0].Transcript;

            // fix encoding for accented characters
            transcript = decodeURIComponent(escape(transcript));

            // update the textarea with the latest result
            $('#transcript').val(transcription + transcript + "\n");

            // if this transcript segment is final, add it to the overall transcription
            if (!results[0].IsPartial) {
                //scroll the textarea down
                $('#transcript').scrollTop($('#transcript')[0].scrollHeight);

                transcription += transcript + "\n";
            }
        }
    }
}

let closeSocket = function () {
    if (socket.OPEN) {
        micStream.stop();

        // Send an empty frame so that Transcribe initiates a closure of the WebSocket after submitting all transcripts
        let emptyMessage = getAudioEventMessage(Buffer.from(new Buffer([])));
        let emptyBuffer = eventStreamMarshaller.marshall(emptyMessage);
        socket.send(emptyBuffer);
    }
}

$('#stop-button').click(function () {
    closeSocket();
    toggleStartStop();
});

$('#reset-button').click(function (){
    $('#transcript').val('');
    transcription = '';
});

function toggleStartStop(disableStart = false) {
    $('#start-button').prop('disabled', disableStart);
    $('#stop-button').attr("disabled", !disableStart);
}

function showError(message) {
    alert(message);
}

function convertAudioToBinaryMessage(audioChunk) {
    let raw = mic.toRaw(audioChunk);

    if (raw == null)
        return;

    // downsample and convert the raw audio bytes to PCM
    let downsampledBuffer = audioUtils.downsampleBuffer(raw, sampleRate);
    let pcmEncodedBuffer = audioUtils.pcmEncode(downsampledBuffer);

    // add the right JSON headers and structure to the message
    let audioEventMessage = getAudioEventMessage(Buffer.from(pcmEncodedBuffer));

    //convert the JSON object + headers into a binary event stream message
    let binary = eventStreamMarshaller.marshall(audioEventMessage);

    return binary;
}

function getAudioEventMessage(buffer) {
    // wrap the audio data in a JSON envelope
    return {
        headers: {
            ':message-type': {
                type: 'string',
                value: 'event'
            },
            ':event-type': {
                type: 'string',
                value: 'AudioEvent'
            }
        },
        body: buffer
    };
}

function createPresignedUrl() {
    let endpoint = "transcribestreaming." + region + ".amazonaws.com:8443";

    // get a preauthenticated URL that we can use to establish our WebSocket
    return v4.createPresignedURL(
        'GET',
        endpoint,
        '/stream-transcription-websocket',
        'transcribe',
        crypto.createHash('sha256').update('', 'utf8').digest('hex'), {
            'key': window.accessKey,
            'secret': window.accessSecret,
            'sessionToken': '',
            'protocol': 'wss',
            'expires': 90,
            'region': region,
            'query': "language-code=" + languageCode + "&media-encoding=pcm&sample-rate=" + sampleRate
        }
    );
}
