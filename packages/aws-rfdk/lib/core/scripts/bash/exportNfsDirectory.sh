#!/bin/bash

# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Exports a directory to a client so they are able to access it via NFS.
#
# Script Arguments:
#  $1 -- Directory to export
#  $2 -- Client name; for possible values, see Machine Name Formats at https://linux.die.net/man/5/exports
#  $3 -- NFS export options; see https://linux.die.net/man/5/exports

if [ $# -lt 3 ]; then
  echo "Usage: $0 <directory> <client> <export-options>"
  exit 1
fi

EXPORT_DIR=$1
CLIENT_NAME=$2
EXPORT_OPTS=$3

# TODO: Support creating/importing a user with UID/GID and remove this
# Squash all clients to access the filesystem as this user so we don't have
# to deal with user/group permissions yet
if [ $(id nfs-user > /dev/null 2>&1; echo $?) -eq 1 ]; then
  sudo useradd nfs-user
fi
USERNAME="nfs-user"
NFS_USER_UID=$(id $USERNAME -u)
NFS_USER_GID=$(id $USERNAME -g)
EXPORT_OPTS="$EXPORT_OPTS,all_squash,anonuid=$NFS_USER_UID,anongid=$NFS_USER_GID"

# /etc/exports may be missing a newline at end of file.
if test $(tail -c 1 /etc/exports | wc -l) -eq 0; then
  echo "" | sudo tee -a /etc/exports;
fi

sudo mkdir -p "$EXPORT_DIR"
sudo chown "$USERNAME":"$USERNAME" "$EXPORT_DIR"
echo "$EXPORT_DIR $CLIENT_NAME($EXPORT_OPTS)" | sudo tee -a /etc/exports
sudo exportfs -ra
