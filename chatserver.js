import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

const app = express();
app.use(
  cors({
    origin: "*",
  })
);
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

//Store room in an object.
var rooms = {};
//Global user object, since we want to know what rooms each user is in etc.
var users = {};

//Default room.
rooms.lobby = new Room("lobby");
rooms.lobby.setTopic("Welcome to the lobby!");

io.on("connection", function (socket) {
  //This gets performed when a user joins the server.
  socket.on("adduser", function (username, fn) {
    //Check if username is avaliable.
    if (
      username &&
      users[username] === undefined &&
      username.toLowerCase() != "server" &&
      username.length < 21
    ) {
      socket.username = username;

      //Store user object in global user roster.
      users[username] = {
        username: socket.username,
        channels: {},
        socket: this,
      };
      fn(true); // Callback, user name was available
    } else {
      fn(false); // Callback, it wasn't available
    }
  });

  //When a user joins a room this processes the request.
  socket.on("joinroom", function (joinObj, fn) {
    if (!socket.username) {
      console.log("joinroom: User not authenticated");
      return fn(false, "Not authenticated"); // Adduser hasn't been called
    }
    if (!joinObj) {
      console.log("joinroom: no payload");
      return; // no payload
    }
    const { room, pass } = joinObj;
    if (!room) {
      console.log("joinroom: wrong payload", joinObj);
      return fn(false, "Room name missing"); // Missing data in payload
    }

    //If the room does not exist
    if (rooms[room] === undefined) {
      const newRoom = new Room(room);
      rooms[room] = newRoom;
      //Op the user if he creates the room.
      newRoom.addOp(socket.username);
      //If the user wants to password protect the room we set the password.
      if (pass) {
        newRoom.setPassword(pass);
      }
      //Keep track of the room in the user object.
      users[socket.username].channels[room] = room;
      //Send the room information to the client.
      fn(true);
      io.sockets.emit(
        "updateusers",
        room,
        newRoom.users,
        newRoom.ops,
        newRoom.banned
      );
      //Update topic
      socket.emit("updatetopic", room, newRoom.topic, socket.username);
      io.sockets.emit("servermessage", "join", room, socket.username);
    } else {
      const r = rooms[room];
      //Check if user submits the correct password
      if (r.locked && pass !== r.password) {
        return fn(false, "Wrong password");
      }
      //Check if the user has been added to the ban list.
      if (r.banned[socket.username]) {
        return fn(false, "Banned");
      }

      //We need to let the server know beforehand so that he starts to prepare the client template.
      fn(true);
      //Add user to room.
      r.addUser(socket.username);
      //Keep track of the room in the user object.
      users[socket.username].channels[room] = room;
      //Send the room information to the client.
      io.sockets.emit("updateusers", room, r.users, r.ops, r.banned);
      socket.emit("updatechat", room, r.messageHistory);
      socket.emit("updatetopic", room, r.topic, socket.username);
      io.sockets.emit("servermessage", "join", room, socket.username);
    }
  });

  // when the client emits 'sendchat', this listens and executes
  socket.on("sendmsg", function (data) {
    if (!socket.username) {
      console.log("sendmsg: User not authenticated");
      return; // Adduser hasn't been called
    }
    if (!data) {
      console.log("sendmsg: no payload");
      return; // no payload
    }
    const { roomName, msg } = data;
    if (!roomName || !msg) {
      console.log("sendmsg: wrong payload", data);
      return; // Missing data in payload
    }

    //Check if user is allowed to send message.
    if (users[socket.username].channels[roomName] !== roomName) return;

    //Update the message history for the room that the user sent the message to.
    var messageObj = {
      nick: socket.username,
      timestamp: new Date(),
      message: msg.substring(0, 200),
    };
    rooms[roomName].addMessage(messageObj);
    io.sockets.emit("updatechat", roomName, rooms[roomName].messageHistory);
  });

  socket.on("privatemsg", function (msgObj, fn) {
    if (!socket.username) {
      console.log("privatemsg: User not authenticated");
      return fn(false); // Adduser hasn't been called
    }
    if (!msgObj) {
      console.log("privatemsg: no payload");
      return fn(false); // no payload
    }
    const { nick, message } = msgObj;
    if (!message || !nick) {
      console.log("privatemsg: wrong payload", msgObj);
      return fn(false); // Missing data in payload
    }
    //If user exists in global user list.
    if (users[nick] !== undefined) {
      //Send the message only to this user.
      users[nick].socket.emit("recv_privatemsg", socket.username, message);
      //Callback recieves true.
      fn(true);
    }
    fn(false);
  });

  //When a user leaves a room this gets performed.
  socket.on("partroom", function (room) {
    if (!socket.username) {
      console.log("partroom: User not authenticated");
      return; // Adduser hasn't been called
    }
    //remove the user from the room roster and room op roster.
    rooms[room].removeUser(socket.username);
    //Remove the channel from the user object in the global user roster.
    delete users[socket.username].channels[room];
    //Update the userlist in the room.
    io.sockets.emit(
      "updateusers",
      room,
      rooms[room].users,
      rooms[room].ops,
      rooms[room].banned
    );
    io.sockets.emit("servermessage", "part", room, socket.username);
  });

  // when the user disconnects.. perform this
  socket.on("disconnect", function () {
    if (socket.username) {
      //If the socket doesn't have a username the client joined and parted without
      //chosing a username, so we just close the socket without any cleanup.
      for (var room in users[socket.username].channels) {
        //Remove the user from users/ops lists in the rooms he's currently in.
        rooms[room].removeUser(socket.username);
        io.sockets.emit(
          "updateusers",
          room,
          rooms[room].users,
          rooms[room].ops,
          rooms[room].banned
        );
      }

      //Broadcast the the user has left the channels he was in.
      io.sockets.emit(
        "servermessage",
        "quit",
        users[socket.username].channels,
        socket.username
      );
      //Remove the user from the global user roster.
      delete users[socket.username];
    }
  });

  //When a user tries to kick another user this gets performed.
  socket.on("kick", function (kickObj, fn) {
    if (!socket.username) {
      console.log("kick: User not authenticated");
      return fn(false); // Adduser hasn't been called
    }
    if (!kickObj) {
      console.log("kick: no payload");
      return fn(false); // No payload
    }
    const { room, user } = kickObj;
    if (!room || !user) {
      console.log("kick: wrong payload", kickObj);
      return fn(false); // Wrong payload
    }
    const r = rooms[room];
    if (r.ops[socket.username]) {
      //Remove the channel from the user in the global user roster.
      delete users[user].channels[room];
      //Remove the user from the room roster.
      r.removeUser(user);
      //Broadcast to the room who got kicked.
      io.sockets.emit("kicked", room, user, socket.username);
      //Update user list for room.
      io.sockets.emit("updateusers", room, r.users, r.ops, r.banned);
      fn(true);
    } else {
      fn(false); // Send back failed, debugging..
    }
  });

  //When a user tries to op another user this gets performed.
  socket.on("op", function (opObj, fn) {
    if (!socket.username) {
      console.log("op: User not authenticated");
      return fn(false); // Adduser hasn't been called
    }
    if (!opObj) {
      console.log("op: no payload");
      return fn(false); // No payload
    }
    const { room, user } = opObj;
    if (!room || !user) {
      console.log("op: wrong payload", opObj);
      return fn(false); // Wrong payload
    }
    const r = rooms[room];
    if (r.ops[socket.username] !== undefined) {
      //Op the user.
      r.addOp(user);
      //Broadcast to the room who got opped.
      io.sockets.emit("opped", room, user, socket.username);
      //Update user list for room.
      io.sockets.emit("updateusers", room, r.users, r.ops, r.banned);
      fn(true);
    } else {
      fn(false); // Send back failed, debugging..
    }
  });

  //When a user tries to deop another user this gets performed.
  socket.on("deop", function (deopObj, fn) {
    if (!socket.username) {
      console.log("deop: User not authenticated");
      return fn(false); // Adduser hasn't been called
    }
    if (!deopObj) {
      console.log("deop: no payload");
      return fn(false); // No payload
    }
    const { room, user } = deopObj;
    if (!room || !user) {
      console.log("deop: wrong payload", deopObj);
      return fn(false); // Wrong payload
    }
    const r = rooms[room];
    //If user is OP
    if (r.ops[socket.username] !== undefined) {
      //Add the user to the room roster.
      r.deop(user);
      //Broadcast to the room who got opped.
      io.sockets.emit("deopped", room, user, socket.username);
      //Update user list for room.
      io.sockets.emit("updateusers", room, r.users, r.ops, r.banned);
      fn(true);
    } else {
      fn(false); // Send back failed, debugging..
    }
  });

  //Handles banning the user from a room.
  socket.on("ban", function (banObj, fn) {
    if (!socket.username) {
      console.log("ban: User not authenticated");
      return fn(false); // Adduser hasn't been called
    }
    if (!banObj) {
      console.log("ban: no payload");
      return fn(false); // No payload
    }
    const { room, user } = banObj;
    if (!room || !user) {
      console.log("ban: wrong payload", banObj);
      return fn(false); // Wrong payload
    }
    const r = rooms[room];
    if (r.ops[socket.username] !== undefined) {
      //Remove the channel from the user in the global user roster.
      delete users[user].channels[room];
      //Add the user to the ban list and remove him from the room user roster.
      r.banUser(user);
      //Kick the user from the room.
      io.sockets.emit("banned", room, user, socket.username);
      io.sockets.emit("updateusers", room, r.users, r.ops, r.banned);
      fn(true);
    }
    fn(false);
  });

  //Handles unbanning the user.
  socket.on("unban", function (unbanObj, fn) {
    if (!socket.username) {
      console.log("unban: User not authenticated");
      return fn(false); // Adduser hasn't been called
    }
    if (!unbanObj) {
      console.log("unban: no payload");
      return fn(false); // No payload
    }
    const { room, user } = unbanObj;
    if (!room || !user) {
      console.log("unban: wrong payload", unbanObj);
      return fn(false); // Wrong payload
    }
    const r = rooms[room];
    if (r.ops[socket.username] !== undefined) {
      //Remove the user from the room ban list.
      delete r.banned[user];
      io.sockets.emit("updateusers", room, r.users, r.ops, r.banned);
      fn(true);
    }
    fn(false);
  });

  //Returns a list of all avaliable rooms.
  socket.on("rooms", function () {
    socket.emit("roomlist", rooms);
  });

  //Returns a list of all connected users.
  socket.on("users", function () {
    var userlist = [];

    //We need to construct the list since the users in the global user roster have a reference to socket, which has a reference
    //back to users so the JSON serializer can't serialize them.
    for (var user in users) {
      userlist.push(user);
    }
    socket.emit("userlist", userlist);
  });

  //Sets topic for room.
  socket.on("settopic", function (topicObj, fn) {
    if (!socket.username) {
      console.log("settopic: User not authenticated");
      return fn(false); // Adduser hasn't been called
    }
    if (!topicObj) {
      console.log("settopic: no payload");
      return fn(false); // No payload
    }
    const { room, topic } = topicObj;
    if (!room || !topic) {
      console.log("settopic: wrong payload", topicObj);
      return fn(false); // Wrong payload
    }
    //If user is OP
    if (rooms[room].ops[socket.username] !== undefined) {
      rooms[room].setTopic(topic);
      //Broadcast to room that the user changed the topic.
      io.sockets.emit("updatetopic", room, topic, socket.username);
      fn(true);
    }
    //Return false if topic was not set.
    fn(false);
  });

  //Password locks the room.
  socket.on("setpassword", function (passwordObj, fn) {
    if (!socket.username) {
      console.log("setpassword: User not authenticated");
      return fn(false); // Adduser hasn't been called
    }
    if (!passwordObj) {
      console.log("setpassword: no payload");
      return fn(false); // No payload
    }
    const { room, password } = passwordObj;
    if (!room || !password) {
      console.log("setpassword: wrong payload", passwordObj);
      return fn(false); // Wrong payload
    }
    //If user is OP
    if (rooms[room].ops[socket.username] !== undefined) {
      rooms[room].setPassword(password);
      fn(true);
    }
    fn(false);
  });

  //Unlocks the room.
  socket.on("removepassword", function (remObj, fn) {
    if (!socket.username) {
      console.log("removepassword: User not authenticated");
      return fn(false); // Adduser hasn't been called
    }
    if (!remObj) {
      console.log("removepassword: no payload");
      return fn(false); // No payload
    }
    const { room } = remObj;
    if (!room) {
      console.log("removepassword: wrong payload", remObj);
      return fn(false); // Wrong payload
    }
    if (rooms[room].ops[socket.username] !== undefined) {
      rooms[room].clearPassword();
      fn(true);
    }
    fn(false);
  });
});

//Define the Room class/object.
function Room(name) {
  (this.name = name),
    (this.users = {}),
    (this.ops = {}),
    (this.opsHistory = {}),
    (this.banned = {}),
    (this.messageHistory = []),
    (this.topic = "No topic has been set for room.."),
    (this.locked = false),
    (this.password = ""),
    (this.removeUser = function (user) {
      if (!user) return false;
      delete this.users[user];
      delete this.ops[user];
      return true;
    }),
    (this.addOp = function (user) {
      if (!user) return false;
      if (this.users[user]) delete this.users[user];
      this.ops[user] = user;
      this.opsHistory[user] = user;
      return true;
    }),
    (this.deop = function (user) {
      if (!user) return false;
      if (this.ops[user]) delete this.ops[user];
      if (this.opsHistory[user]) delete this.opsHistory[user];
      this.users[user] = user;
      return true;
    }),
    (this.addUser = function (user) {
      if (!user) return false;
      if (this.banned[user]) return false;
      if (this.opsHistory[user]) {
        this.ops[user] = user;
        return true;
      }
      this.users[user] = user;
      return true;
    });
  this.banUser = function (user) {
    if (!user) return false;
    this.banned[user] = user;
    if (this.users[user]) delete this.users[user];
    if (this.ops[user]) {
      delete this.ops[user];
      delete this.opsHistory[user];
    }
    return true;
  };
  this.addMessage = function (message) {
    if (!message) return false;
    this.messageHistory.push(message);
    return true;
  };
  this.setTopic = function (topic) {
    if (!topic) return false;
    this.topic = topic;
    return true;
  };
  this.setPassword = function (pass) {
    if (!pass) return false;
    this.password = pass;
    this.locked = true;
    return true;
  };
  this.clearPassword = function () {
    this.password = "";
    this.locked = false;
  };
}

server.listen(8080, () => {
  console.log(`Listening on :8080`);
});
