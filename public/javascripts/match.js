var socket = io();
var query_list = {};
var query = location.search.replace("?", "").split('&');
var check_timer;
var c_name = "NoName";
var h_name = "NoName";
var load_map_size_x;
var load_map_size_y;
var temp_msg;
var key;

window.onload = function () {
    //document.getElementsByTagName("body")[0].classList.add("animation_stop");
};

for (parameters of query) {
    var qp = parameters.split('=');
    if (qp.length == 2) {
        query_list[qp[0]] = qp[1];
    }
}

if (query_list.room_id) {
    var url = './../api/game?room_id=' + query_list.room_id;
    fetch(url)
        .then(function (data) {
            return data.json();
        })
        .then(function (json) {
            if (json) {
                socket.emit('looker_join', query_list.room_id + "?" + query_list.room_token);
                document.getElementById('server_name').textContent = String(json.name);
                if (json.cpu) {
                    buttle_mode = "（テスト）";
                } else {
                    buttle_mode = "";
                }
                document.title += " - " + document.getElementById('server_name').textContent + buttle_mode;
                
                var server_init = {};
                server_init.room_id = query_list.room_id + "?" + query_list.room_token;
                // 予選: 本家の CPU の代わりにボット(L1〜L30)と戦う
                if (query_list.bot) {
                    server_init.bot = Number(query_list.bot);
                    server_init.bot_seed = Number(query_list.seed);
                }
                socket.emit("match_init", server_init);
            }
            else {
                document.getElementById('server_name').textContent = "存在しないサーバー";
            }
        });
}

var match_start_check = function () {
    socket.emit("match_start_check");
};
var check_flag = true;

socket.on("match_init_rec", function (msg) {
    if (!msg.error) {
        // 運営画面から開いたときは、参加者のプログラムを自動で読み込ませる
        var prog_cool = query_list.prog_cool ? "&prog=" + query_list.prog_cool : "";
        var prog_hot = query_list.prog_hot ? "&prog=" + query_list.prog_hot : "";
        // 予選はボットが後攻に入る。CPU の枠に「ボット L5」と出す
        if (query_list.bot) prog_hot += "&bot=" + query_list.bot;
        document.getElementById('cool_player_iframe').src = "/match/player?room_id=" + query_list.room_id + "&room_token=" + query_list.room_token + "&chara=cool&key=" + msg.key + prog_cool;
        document.getElementById('hot_player_iframe').src = "/match/player?room_id=" + query_list.room_id + "&room_token=" + query_list.room_token + "&chara=hot&key=" + msg.key + prog_hot;
        key = msg.key;
        document.getElementById("game_start").onclick = function () {

            check_flag = false;
            clearInterval(check_timer);
            document.getElementById('ready_area').classList.add("display_off");
            document.getElementById('game_area').classList.remove("display_off");
            socket.emit("match_start", { "room_id": query_list.room_id + "?" + query_list.room_token, "key": key });
        }
        check_flag = true;
        check_timer = setInterval(match_start_check, 500);
    }
    else {
        window.alert("接続先サーバーは使用中です");
        var back_to = query_list.back ? decodeURIComponent(query_list.back) : "";
        window.location.href = /^\/[^\/]/.test(back_to) ? back_to : "/menu-match";
    }
});


socket.on("match_start_check_rec", function (msg) {
    var game_start_button = document.getElementById('game_start');
    if (check_flag) {
        if (msg) {
            if (!game_start_button.classList.contains("display_on")) {
                game_start_button.classList.add("display_on");
            }
        }
        else {
            if (game_start_button.classList.contains("display_on")) {
                game_start_button.classList.remove("display_on");
            }
        }
    }
});


socket.on("joined_room", function (msg) {
    load_map_size_x = msg.x_size;
    load_map_size_y = msg.y_size;
    if (msg.cool_name) {
        c_name = msg.cool_name;
    }
    if (msg.hot_name) {
        h_name = msg.hot_name;
    }
    if (msg.cpu_name) {
        h_name = msg.cpu_name;
    }
});

socket.on("updata_board", function (msg) {
    clearInterval(check_timer);
    document.getElementById('ready_area').classList.add("display_off");
    document.getElementById('game_area').classList.remove("display_off");
    temp_msg = msg;
    if (msg.effect) {
        makeTable(msg, load_map_size_x, load_map_size_y, msg.effect, "game_board");
    }
    else {
        makeTable(msg, load_map_size_x, load_map_size_y, 0, "game_board");
    }
});

socket.on("new_board", function (msg) {
    temp_msg = msg;
    game_bgm_flag = true;
    if (msg.effect) {
        makeTable(msg, load_map_size_x, load_map_size_y, msg.effect, "game_board");
    }
    else {
        makeTable(msg, load_map_size_x, load_map_size_y, 0, "game_board");
    }
});

var game_result_msg = "";
var game_result_info = "";

socket.on("game_result", function (msg) {
    if (localStorage["SOUND_STATUS"]) {
        if (localStorage["SOUND_STATUS"] == "on") {
            gameBgm.stop();
            resultSound.play();
        }
    }
    else {
        gameBgm.stop();
        resultSound.play();
    }
    game_result_msg = msg.winer;
    game_result_info = msg.info;

    game_result_display(msg.winer, msg.info);

    socket.emit("match_end", { "room_id": query_list.room_id, "key": key });
});

socket.on("error", function (msg) {
    gameBgm.stop();
});

function game_result_display(winer, info) {
    var result = document.createElement("div");
    result.setAttribute("id", "game_result");
    var img = document.createElement('img');
    if (winer == "cool") {
        img.src = '/images/coolwin.png';
    }
    else if (winer == "hot") {
        img.src = '/images/hotwin.png';
    }
    else {
        img.src = '/images/draw.png';
    }
    result.appendChild(img);


    var back_button = document.createElement("div");
    var re_button = document.createElement("div");

    back_button.setAttribute("id", "back_button");
    re_button.setAttribute("id", "re_button");

    var back_button_link = document.createElement('a');
    back_button_link.classList.add("button_link");
    back_button_link.href = "/menu-match";
    back_button_link.innerText = "戻る";
    // 運営画面から開いた対戦は、結果が記録された運営画面へ戻す(同じサイト内のパスだけ受け付ける)
    var back_to = query_list.back ? decodeURIComponent(query_list.back) : "";
    if (/^\/[^\/]/.test(back_to)) {
        back_button_link.href = back_to;
        back_button_link.innerText = "運営画面へ";
    }
    back_button.appendChild(back_button_link);

    var re_button_link = document.createElement('a');
    re_button_link.classList.add("button_link");
    re_button_link.href = "/match" + location.search;
    re_button_link.innerText = "もう一度";
    re_button.appendChild(re_button_link);

    result.appendChild(back_button);
    result.appendChild(re_button);

    document.getElementById("game_board").appendChild(result);


    var winer_info_div = document.createElement("div");
    winer_info_div.setAttribute("id", "winer_info_div");

    var twiner_info = document.createElement("div");
    twiner_info.setAttribute("id", "winer_info_title");
    twiner_info.appendChild(document.createTextNode("リザルト情報"));

    var winer_info = document.createElement("div");
    winer_info.setAttribute("id", "winer_info");
    winer_info.appendChild(document.createTextNode(info));

    winer_info_div.appendChild(twiner_info);
    winer_info_div.appendChild(winer_info);

    document.getElementById("game_info_div").appendChild(winer_info_div);

}

window.addEventListener("resize", function () {
    if (temp_msg) {
        if (temp_msg.effect) {
            makeTable(temp_msg, load_map_size_x, load_map_size_y, temp_msg.effect, "game_board");
        }
        else {
            makeTable(temp_msg, load_map_size_x, load_map_size_y, 0, "game_board");
        }
    }
    if (game_result_msg) {
        game_result_display(game_result_msg, game_result_info);
    }
});

