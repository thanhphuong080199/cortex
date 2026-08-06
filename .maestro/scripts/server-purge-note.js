// Permanently deletes a note on the server, standing in for "xóa vĩnh viễn 1 note trên web".
//
// Two calls, because purge is not the same as trash: DELETE /notes/:id sets deleted_at (the
// note is recoverable and still syncs, it just stops showing in the default views), and
// DELETE /notes/:id/purge is what actually removes the row. Only the second one produces the
// hard delete the device has to observe -- and a hard delete is the operation most likely to be
// mishandled by a replication stream, which is why it is worth a flow of its own.

function call(path, method) {
  var res = http.request(API_URL + path, {
    method: method,
    headers: { Authorization: "Bearer " + ACCESS_TOKEN },
  });
  if (!res.ok) {
    throw new Error(method + " " + path + " -> " + res.status + " " + res.body);
  }
}

call("/notes/" + NOTE_ID, "DELETE");
call("/notes/" + NOTE_ID + "/purge", "DELETE");
