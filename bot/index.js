// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

// Import base server modules
const fetch = require('node-fetch');
const express = require('express');
const jwt_decode = require('jwt-decode');
const app = express();
if (process.env.NODE_ENV === 'development.local') {
    require('dotenv').config({ path: './.env.development.local' });
}
else {
    require('dotenv').config()
}

// Import BotFramework modules 
const { MessageFactory, TeamsInfo, BotFrameworkAdapter } = require('botbuilder');

// Import local modules
const { BotActivityHandler } = require('./teamsBot');
const botActivityHandler = new BotActivityHandler();
let meetingInfoRepository = require('./meetingInfoRepository');

// Backup of the conversation reference for TESTS ONLY
// const conversationRefBackup = require('./conversationRefBackup.json');
// meetingInfoRepository.setConversationReference(conversationRefBackup);

// SSO constants
const graphScopes = 'https://graph.microsoft.com/' + process.env.GRAPH_SCOPES;

// In-meeting dialog constants
const dialogWidth = 280;
const dialogHeight = 180;
const dialogTitle = "Test in-meeting dialog"
const dialogUrl = process.env.TEAMSFX_ENDPOINT + "/dialog"; //The view for your in-meeting dialog ( see Dialog.js in tabs/src/components )

const externalResourceUrl = `https://teams.microsoft.com/l/bubble/${process.env.TEAMS_APP_ID}?url=${dialogUrl}&height=${dialogHeight}&width=${dialogWidth}&title=${dialogTitle}&completionBotId=${process.env.BOT_ID}`;

// Generic error handler for fetch() calls
let handleQueryError = function (err) {
    console.log("handleQueryError called: ", err);
    return new Response(JSON.stringify({
        code: 400,
        message: 'Stupid network Error'
    }));
};

/** 
 * Create Bot Framework adapter.
 * See https://aka.ms/about-bot-adapter to learn more about adapters.
 */
const adapter = new BotFrameworkAdapter({
    appId: process.env.BOT_ID,
    appPassword: process.env.BOT_PASSWORD
});
adapter.onTurnError = async (context, error) => {
    // This check writes out errors to console log .vs. app insights.
    // NOTE: In production environment, you should consider logging this to Azure
    //       application insights.
    console.error(`\n [onTurnError] unhandled error: ${error}`);

    // Send a trace activity, which will be displayed in Bot Framework Emulator
    await context.sendTraceActivity(
        'OnTurnError Trace',
        `${error}`,
        'https://www.botframework.com/schemas/error',
        'TurnError'
    );

    // Send a message to the user
    await context.sendActivity('The bot encountered an error or bug.');
    await context.sendActivity('To continue to run this bot, please fix the bot source code.');
};

/** 
 * Exchange a SSO token for a Graph access token
 */
app.get('/getGraphAccessToken', async (req, res) => {

    let participantId = jwt_decode(req.query.ssoToken)['oid']; // Get the participant ID from the decoded token

    let tenantId = jwt_decode(req.query.ssoToken)['tid']; // Get the tenant ID from the decoded token
    let accessTokenEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

    /** 
     * Create your access token query parameters
     * Learn more: https://docs.microsoft.com/en-us/azure/active-directory/develop/v2-oauth2-on-behalf-of-flow#first-case-access-token-request-with-a-shared-secret
     */
    let accessTokenQueryParams = {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        client_id: process.env.M365_CLIENT_ID,
        client_secret: process.env.M365_CLIENT_SECRET,
        assertion: req.query.ssoToken,
        scope: graphScopes,
        requested_token_use: "on_behalf_of",
    };

    accessTokenQueryParams = new URLSearchParams(accessTokenQueryParams).toString();

    let accessTokenReqOptions = {
        method: 'POST',
        headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: accessTokenQueryParams
    };

    let response = await fetch(accessTokenEndpoint, accessTokenReqOptions).catch(handleQueryError);

    let data = await response.json();
    if (!response.ok) {
        if ((data.error === 'invalid_grant') || (data.error === 'interaction_required')) {
            // This is expected if it's the user's first time running the app ( user must consent ) or the admin requires MFA
            console.log("User must consent or perform MFA. You may also encouter this error if your client ID or secret is incorrect.");
            res.status(403).json({ error: 'consent_required' }); // This error triggers the consent flow in the client.
        } else {
            // Unknown error
            console.log('Could not exchange access token for unknown reasons.');
            res.status(500).json({ error: 'Could not exchange access token' });
        }
    } else {
        // The on behalf of token exchange worked. Return the token (data object) to the client.
        res.send(data);
    }
});


/**
 * Call the Voice Echo Bot to join the current meeting
 */
app.get('/getMeetingJoinURL', async (req, res) => {
    
    console.log('getMeetingContext');
    let conversationReference = meetingInfoRepository.getConversationReference(req.query.conversationId); // Look up the conversation reference object by conversation Id
    let meetingId = req.query.meetingId;
    
    adapter.continueConversation(conversationReference, async (context) => {
        /**
         * Retrieve info using BF SDK
         * Learn more: https://docs.microsoft.com/en-us/javascript/api/botbuilder/teamsinfo?view=botbuilder-ts-latest#getMeetingParticipant_TurnContext__string__string__string_
        //  */
        let meetingInfo = await TeamsInfo.getMeetingInfo(context,meetingId);
        console.log("Got meeting info: ", meetingInfo);
        res.send(meetingInfo.details);
    });

});

/**
 * Remove the Voice Echo Bot from the meeting
 */
 app.get('/botJoinMeeting', async (req, res) => {

    console.log('botJoinMeeting');
    let joinURL = req.query.joinURL;
    console.log(joinURL);

    let voiceBotEndpoint = `${process.env.VOICE_ECHO_BOT_URL}/joinCall`;

    let voiceBotRequestParam = {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 'JoinURL' : joinURL })
    };

    let response = await fetch(voiceBotEndpoint, voiceBotRequestParam).catch(handleQueryError);
    let data = await response.json();

    if (!response.ok) {
        console.log("Couldn't join the Voice Echo Bot to the meeting");
        res.status(500).json({ error: 'Error to join Voice Echo Bot' });
    } else {
        res.send(data);
    }

});

/**
 * Run the BotFramework bot instance and listen for incoming messages
 */
app.post('/api/messages', (req, res) => {
    adapter.processActivity(req, res, async (context) => {
        // Process bot activity
        await botActivityHandler.run(context);
    });
});

/** 
 * Get a user's meeting role information
 */
app.get('/getParticipantInfo', async (req, res) => {

    let participantId = jwt_decode(req.query.ssoToken)['oid']; // Get the participant ID from the decoded token
    let tenantId = jwt_decode(req.query.ssoToken)['tid']; // Get the tenant ID from the decoded token
    let meetingId = req.query.meetingId;
    let conversationReference = meetingInfoRepository.getConversationReference(req.query.conversationId); // Look up the conversation reference object by conversation Id

    console.log(`| ${participantId} | ${tenantId} | ${meetingId} | ${JSON.stringify(conversationReference,null,4)} |`)

    adapter.continueConversation(conversationReference, async (context) => {
        /**
         * Retrieve info using BF SDK
         * Learn more: https://docs.microsoft.com/en-us/javascript/api/botbuilder/teamsinfo?view=botbuilder-ts-latest#getMeetingParticipant_TurnContext__string__string__string_
         */
        let participantInfo = await TeamsInfo.getMeetingParticipant(context, meetingId, participantId, tenantId);
        console.log("Got role info: ", participantInfo);
        res.send(participantInfo);
    });
});

/**
 * Display an in-meeting dialog ( modal )
 */
app.get('/inMeetingDialog', (req, res) => {

    let conversationReference = meetingInfoRepository.getConversationReference(req.query.conversationId);

    adapter.continueConversation(conversationReference, async (context) => {
        const replyActivity = MessageFactory.text("In-meeting dialog sent"); // This could be an adaptive card instead
        replyActivity.channelData = {
            notification: {
                alertInMeeting: true,
                externalResourceUrl: externalResourceUrl
            }
        };
        await context.sendActivity(replyActivity);
    });
    res.send({});
});

/** 
 * Handles any requests that don't match the ones above
 */
app.get('*', (req, res) => {
    console.log("Unhandled request: ", req.url);
    res.status(404).send("Path not defined");
});

const port = process.env.PORT || 5000;
app.listen(port);

console.log('API server is listening on port ' + port);
